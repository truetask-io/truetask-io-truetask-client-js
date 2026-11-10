// The whole client against a fake server, on Node's own test runner: nothing to
// install, so `npm test` works in a fresh clone.
//
// The seams these hold:
//
//   - every method's REQUEST - the address, the query string, the method, the
//     headers and the body - because the server is the only other reader of
//     those and it is written in another language;
//   - `filter()`'s escaping, round-tripped through a JS copy of the server's own
//     string reader, so a quote or a backslash in a person's search box cannot
//     change what the filter asks;
//   - every refusal arriving as one `ClientResponseError`, network failures and
//     aborts included;
//   - the package shipping the files its `package.json` points at.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import Truetask, { ClientResponseError, Database } from '../index.js';

const read = (name) => readFileSync(resolve(import.meta.dirname, '..', name), 'utf8');

/** One answer from the fake server. `text` sends a body that is not JSON. */
const reply = ({ status = 200, body = {}, headers = {}, text } = {}) => ({
	ok: status >= 200 && status < 300,
	status,
	headers: new Headers(headers),
	text: async () => (text !== undefined ? text : body === null ? '' : JSON.stringify(body))
});

/** A `fetch` that answers the replies in order and repeats the last one, and
 * the calls it was made with. An `Error` in the list is thrown instead. */
const faked = (...replies) => {
	const calls = [];
	const fetch = async (url, init = {}) => {
		calls.push({
			url,
			method: init.method || 'GET',
			headers: init.headers || {},
			body: init.body === undefined ? undefined : JSON.parse(init.body),
			signal: init.signal
		});
		const next = replies.length > 1 ? replies.shift() : replies[0];
		if (next instanceof Error) throw next;
		return reply(next);
	};
	return { fetch, calls };
};

const page = (items, extra = {}) => ({
	page: 1,
	perPage: 30,
	totalItems: items.length,
	totalPages: 1,
	items,
	...extra
});

const ROW = { id: 'rec1', key: 'CUST-1', title: 'Acme', created: 'c', updated: 'u', Amount: 12 };

/** A client on a fake server, and the database to call. */
const on = (...replies) => {
	const { fetch, calls } = faked(...replies);
	const tt = new Truetask('https://tt.test', 'tok_abc', { fetch });
	return { tt, db: tt.database('db1'), calls, fetch };
};

const refusal = async (promise) => {
	try {
		await promise;
	} catch (err) {
		return err;
	}
	throw new Error('the call was expected to be refused, and was not');
};

/** The global `fetch` replaced for one check and put back after. */
const with_global_fetch = async (fetch, steps) => {
	const had = globalThis.fetch;
	globalThis.fetch = fetch;
	try {
		await steps();
	} finally {
		globalThis.fetch = had;
	}
};

describe('the client itself', () => {
	it('builds its addresses off the url it was given', () => {
		assert.equal(
			new Truetask('https://tt.test/').database('db1').address(),
			'https://tt.test/v1/db/db1'
		);
		// A Truetask served under a path keeps it.
		assert.equal(
			new Truetask('https://x.test/tt').database('db1').address('/records'),
			'https://x.test/tt/v1/db/db1/records'
		);
		// The page's own origin, for a site Truetask serves itself.
		assert.equal(new Truetask('').database('db1').address('/records'), '/v1/db/db1/records');
	});

	it('refuses to be made without an address or a database', () => {
		assert.throws(() => new Truetask(), /url is where Truetask is served/);
		assert.throws(() => new Truetask('https://tt.test').database(''), /a database id/);
		assert.ok(new Truetask('https://tt.test').database('db1') instanceof Database);
	});

	it('sends the credential it holds now, and none when it has none', async () => {
		const { fetch, calls } = faked({ body: page([]) });
		const tt = new Truetask('https://tt.test', '', { fetch });
		await tt.database('db1').getList();
		assert.equal(calls[0].headers.Authorization, undefined);
		tt.credential = 'ttdb_live_1';
		await tt.database('db1').getList();
		assert.equal(calls[1].headers.Authorization, 'Bearer ttdb_live_1');
	});

	it('uses the global fetch when it was given none', async () => {
		const { fetch, calls } = faked({ body: page([ROW]) });
		await with_global_fetch(fetch, async () => {
			const result = await new Truetask('https://tt.test', 'tok').database('db1').getList();
			assert.deepEqual(result.items, [ROW]);
			assert.equal(calls[0].url, 'https://tt.test/v1/db/db1/records?page=1&per_page=30');
		});
	});

	it("says so when there is no fetch at all, rather than failing on 'undefined'", async () => {
		await with_global_fetch(undefined, async () => {
			const err = await refusal(new Truetask('https://tt.test', 'tok').database('db1').getList());
			assert.match(err.message, /No fetch to call Truetask with/);
		});
	});

	it("lets one call bring its own fetch over the client's", async () => {
		const client_fetch = faked({ body: page([]) });
		const call_fetch = faked({ body: page([ROW]) });
		const tt = new Truetask('https://tt.test', 'tok', { fetch: client_fetch.fetch });
		const result = await tt.database('db1').getList(1, 30, { fetch: call_fetch.fetch });
		assert.deepEqual(result.items, [ROW]);
		assert.equal(client_fetch.calls.length, 0);
	});
});

describe('reading', () => {
	it('asks for the schema at the database itself', async () => {
		const schema = { id: 'db1', name: 'Customers', key_prefix: 'CUST', fields: [] };
		const { db, calls } = on({ body: schema });
		assert.deepEqual(await db.schema(), schema);
		assert.equal(calls[0].url, 'https://tt.test/v1/db/db1');
		assert.equal(calls[0].method, 'GET');
		assert.deepEqual(calls[0].headers, { Authorization: 'Bearer tok_abc' });
		// No body, so no Content-Type: a GET that declares one is a GET some
		// proxies and preflights treat differently.
		assert.equal(calls[0].body, undefined);
	});

	it('puts every list option in the query string, and leaves out what was not asked', async () => {
		const { db, calls } = on({ body: page([ROW]) });
		await db.getList(2, 50, {
			filter: 'Status = "Active" && Amount > 10',
			sort: '-Amount',
			expand: 'Contact',
			fields: 'title,Amount'
		});
		assert.equal(
			calls[0].url,
			'https://tt.test/v1/db/db1/records?page=2&per_page=50' +
				'&filter=Status+%3D+%22Active%22+%26%26+Amount+%3E+10' +
				'&sort=-Amount&expand=Contact&fields=title%2CAmount'
		);
		await db.getList();
		assert.equal(calls[1].url, 'https://tt.test/v1/db/db1/records?page=1&per_page=30');
	});

	it('hands the page back as the server sends it', async () => {
		const body = { page: 2, perPage: 50, totalItems: 213, totalPages: 5, items: [ROW] };
		const { db } = on({ body });
		assert.deepEqual(await db.getList(2, 50), body);
	});

	it('pages getFullList until the server runs short', async () => {
		const row = (id) => ({ ...ROW, id });
		const { db, calls } = on(
			{ body: page([row('a'), row('b')], { totalItems: 5, totalPages: 3 }) },
			{ body: page([row('c'), row('d')], { totalItems: 5, totalPages: 3 }) },
			{ body: page([row('e')], { totalItems: 5, totalPages: 3 }) }
		);
		const all = await db.getFullList({ batch: 2, filter: 'Amount > 1' });
		assert.deepEqual(
			all.map((r) => r.id),
			['a', 'b', 'c', 'd', 'e']
		);
		assert.equal(calls.length, 3);
		assert.ok(calls[2].url.includes('page=3&per_page=2&filter=Amount+%3E+1'));
		// `batch` is the client's own option and never reaches the server.
		assert.ok(!calls[0].url.includes('batch'));
	});

	it('stops getFullList on the last page even when it came back full', async () => {
		const { db, calls } = on({ body: page([ROW, ROW], { totalItems: 2, totalPages: 1 }) });
		assert.equal((await db.getFullList({ batch: 2 })).length, 2);
		assert.equal(calls.length, 1);
	});

	it('asks for whole pages by default, the most the server gives', async () => {
		const { db, calls } = on({ body: page([]) });
		await db.getFullList();
		assert.ok(calls[0].url.includes('per_page=500'));
	});

	it('refuses a getFullList batch the server would refuse', async () => {
		const { db } = on({ body: page([]) });
		for (const batch of [0, -1, 501, 2.5, '100'])
			await assert.rejects(db.getFullList({ batch }), /batch is a whole number/);
	});

	it('asks for one row with getFirstListItem', async () => {
		const { db, calls } = on({ body: page([ROW]) });
		assert.deepEqual(await db.getFirstListItem('Email = "a@b.c"', { expand: 'Contact' }), ROW);
		assert.equal(
			calls[0].url,
			'https://tt.test/v1/db/db1/records?page=1&per_page=1&filter=Email+%3D+%22a%40b.c%22&expand=Contact'
		);
	});

	it('answers an empty getFirstListItem with a 404, like a row that is not there', async () => {
		const { db } = on({ body: page([]) });
		const err = await refusal(db.getFirstListItem('Email = "nobody@b.c"'));
		assert.ok(err instanceof ClientResponseError);
		assert.equal(err.status, 404);
		assert.equal(err.isAbort, false);
		assert.match(err.message, /matches that filter/);
		assert.ok(err.url.includes('filter=Email+%3D+%22nobody%40b.c%22'));
	});

	it('reads one row by id, with the id escaped into the address', async () => {
		const { db, calls } = on({ body: ROW });
		assert.deepEqual(await db.getOne('rec 1/2', { expand: 'Contact', fields: 'title' }), ROW);
		assert.equal(
			calls[0].url,
			'https://tt.test/v1/db/db1/records/rec%201%2F2?expand=Contact&fields=title'
		);
		await assert.rejects(db.getOne(''), /a record id is needed/);
	});
});

describe('writing', () => {
	it('inserts a row as JSON and gives back what the server stored', async () => {
		const { db, calls } = on({ status: 201, body: ROW });
		assert.deepEqual(await db.create({ title: 'Acme', Amount: 12, Markets: ['EU'] }), ROW);
		assert.equal(calls[0].url, 'https://tt.test/v1/db/db1/records');
		assert.equal(calls[0].method, 'POST');
		assert.deepEqual(calls[0].body, { title: 'Acme', Amount: 12, Markets: ['EU'] });
		assert.deepEqual(calls[0].headers, {
			Authorization: 'Bearer tok_abc',
			'Content-Type': 'application/json'
		});
	});

	it('changes only the columns it names', async () => {
		const { db, calls } = on({ body: ROW });
		assert.deepEqual(await db.update('rec1', { Amount: null, Contact: [] }), ROW);
		assert.equal(calls[0].url, 'https://tt.test/v1/db/db1/records/rec1');
		assert.equal(calls[0].method, 'PATCH');
		assert.deepEqual(calls[0].body, { Amount: null, Contact: [] });
		await assert.rejects(db.update('', {}), /a record id is needed/);
	});

	it('deletes a row and answers true, with nothing to read', async () => {
		const { db, calls } = on({ status: 204, body: null });
		assert.equal(await db.delete('rec1'), true);
		assert.equal(calls[0].url, 'https://tt.test/v1/db/db1/records/rec1');
		assert.equal(calls[0].method, 'DELETE');
		await assert.rejects(db.delete(''), /a record id is needed/);
	});

	it('adds the headers a call brings, and lets them win', async () => {
		const { db, calls } = on({ body: ROW });
		await db.create({ title: 'x' }, { headers: { 'X-Mine': '1', Authorization: 'Bearer other' } });
		assert.deepEqual(calls[0].headers, {
			Authorization: 'Bearer other',
			'Content-Type': 'application/json',
			'X-Mine': '1'
		});
	});
});

describe('refusals', () => {
	it("carries the server's own words, status and body", async () => {
		const detail = "'Status': no such choice 'Nope' (choices: Active, Paused)";
		const { db } = on({ status: 422, body: { detail } });
		const err = await refusal(db.create({ title: 'x', Status: 'Nope' }));
		assert.ok(err instanceof ClientResponseError);
		assert.equal(err.name, 'ClientResponseError');
		assert.equal(err.message, detail);
		assert.equal(err.status, 422);
		assert.deepEqual(err.response, { detail });
		assert.equal(err.url, 'https://tt.test/v1/db/db1/records');
		assert.equal(err.isAbort, false);
		assert.equal(err.retryAfter, null);
	});

	it('keeps a body that is not JSON, which is how a proxy answers', async () => {
		const { db } = on({ status: 502, text: '<html>Bad gateway</html>' });
		const err = await refusal(db.getList());
		assert.equal(err.status, 502);
		assert.equal(err.response, '<html>Bad gateway</html>');
		assert.equal(err.message, 'Truetask answered 502.');
	});

	it("keeps FastAPI's own validation body whole, which is a list and not a sentence", async () => {
		const body = { detail: [{ loc: ['query', 'per_page'], msg: 'less than or equal to 500' }] };
		const { db } = on({ status: 422, body });
		const err = await refusal(db.getList(1, 9000));
		assert.deepEqual(err.response, body);
		assert.equal(err.message, 'Truetask answered 422.');
	});

	it('reads how long to wait off a 429', async () => {
		const { db } = on({
			status: 429,
			body: { detail: 'Too many' },
			headers: { 'Retry-After': '30' }
		});
		const err = await refusal(db.getList());
		assert.equal(err.status, 429);
		assert.equal(err.retryAfter, 30);
		assert.equal(err.message, 'Too many');
	});

	it('reads a Retry-After that came as a date', async () => {
		const at = new Date(Date.now() + 90_000).toUTCString();
		const { db } = on({ status: 429, body: {}, headers: { 'Retry-After': at } });
		const err = await refusal(db.getList());
		assert.ok(err.retryAfter > 80 && err.retryAfter <= 90);
	});

	it('turns a network failure into the same error', async () => {
		const down = new TypeError('fetch failed');
		const { db } = on(down);
		const err = await refusal(db.getList());
		assert.ok(err instanceof ClientResponseError);
		assert.equal(err.status, 0);
		assert.equal(err.isAbort, false);
		assert.equal(err.originalError, down);
		assert.equal(err.message, 'Truetask could not be reached: fetch failed.');
	});

	it('marks a cancelled call as one', async () => {
		const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
		const { db } = on(aborted);
		const stop = new AbortController();
		stop.abort();
		const err = await refusal(db.getList(1, 30, { signal: stop.signal }));
		assert.equal(err.isAbort, true);
		assert.equal(err.status, 0);
		assert.equal(err.message, 'The request was cancelled.');
	});

	it('passes the signal through to fetch', async () => {
		const { db, calls } = on({ body: page([]) });
		const stop = new AbortController();
		await db.getList(1, 30, { signal: stop.signal });
		assert.equal(calls[0].signal, stop.signal);
	});
});

// `api/v1/_shared/db_filter.py`'s `_read_string`, in JS: inside a quoted
// literal a backslash means "the next character, literally". A bound value is
// safe exactly when this reads it back unchanged.
const read_string = (text, at) => {
	const quote = text[at];
	let out = '';
	let i = at + 1;
	while (i < text.length) {
		if (text[i] === '\\' && i + 1 < text.length) {
			out += text[i + 1];
			i += 2;
			continue;
		}
		if (text[i] === quote) return { value: out, next: i + 1 };
		out += text[i];
		i += 1;
	}
	throw new Error('unclosed quote');
};

describe('filter()', () => {
	const tt = new Truetask('https://tt.test', 'tok');

	it('binds the kinds of value the grammar has', () => {
		assert.equal(
			tt.filter('Amount > {:min} && Paid = {:paid}', { min: 10.5, paid: true }),
			'Amount > 10.5 && Paid = true'
		);
		assert.equal(tt.filter('N = {:n}', { n: -3 }), 'N = -3');
		assert.equal(tt.filter('Off = {:off}', { off: false }), 'Off = false');
		assert.equal(tt.filter('Owner = {:nobody}', { nobody: null }), 'Owner = null');
		assert.equal(tt.filter('Owner = {:nobody}', { nobody: undefined }), 'Owner = null');
		assert.equal(tt.filter('Name = {:n}', { n: 'Acme' }), 'Name = "Acme"');
		// A date column holds a bare day, so that is what a Date binds as.
		assert.equal(
			tt.filter('Signed > {:d}', { d: new Date('2026-01-31T22:00:00Z') }),
			'Signed > "2026-01-31"'
		);
		assert.equal(tt.filter('A = {:x} || A = {:x}', { x: 1 }), 'A = 1 || A = 1');
		assert.equal(tt.filter('Status = "Active"'), 'Status = "Active"');
	});

	it('escapes a quote and a backslash so the server reads back what was typed', () => {
		for (const typed of [
			"O'Neil",
			'say "hi"',
			'a\\b',
			'back\\\\slash',
			'a\\"b',
			'" || 1 = 1 || "',
			'ends with a backslash \\',
			'新しい "顧客"'
		]) {
			const expr = tt.filter('Name = {:q}', { q: typed });
			assert.ok(expr.startsWith('Name = "'));
			const { value, next } = read_string(expr, expr.indexOf('"'));
			assert.equal(value, typed);
			// Nothing of the value is left outside the literal, which is what an
			// injected `"` would do.
			assert.equal(next, expr.length);
		}
	});

	it('never binds a value that reads like another placeholder', () => {
		assert.equal(
			tt.filter('A = {:a} && B = {:b}', { a: '{:b}', b: 'real' }),
			'A = "{:b}" && B = "real"'
		);
	});

	it('refuses what the grammar cannot say, instead of sending it', () => {
		assert.throws(() => tt.filter('A = {:missing}', { other: 1 }), /nothing binds \{:missing\}/);
		assert.throws(() => tt.filter('A = {:a}', {}), /nothing binds/);
		assert.throws(() => tt.filter('A = {:a}', { a: ['x'] }), /is a list/);
		assert.throws(() => tt.filter('A = {:a}', { a: { x: 1 } }), /is a object/);
		assert.throws(() => tt.filter('A = {:a}', { a: NaN }), /not a number/);
		assert.throws(() => tt.filter('A = {:a}', { a: Infinity }), /not a number/);
		assert.throws(() => tt.filter('A = {:a}', { a: new Date('nope') }), /invalid Date/);
	});

	it('is what a list call sends', async () => {
		const { tt: client, db, calls } = on({ body: page([]) });
		await db.getList(1, 30, { filter: client.filter('Name ~ {:q}', { q: 'say "hi"' }) });
		// Read it back the way the server does, out of the query string.
		assert.equal(new URL(calls[0].url).searchParams.get('filter'), 'Name ~ "say \\"hi\\""');
	});
});

describe('the package', () => {
	it('ships the files its package.json points at', () => {
		const manifest = JSON.parse(read('package.json'));
		assert.equal(manifest.name, '@truetask/db');
		assert.equal(manifest.license, 'MIT');
		assert.equal(manifest.type, 'module');
		assert.equal(manifest.exports['.'].types, './index.d.ts');
		assert.equal(manifest.exports['.'].default, './index.js');
		for (const file of manifest.files) assert.doesNotThrow(() => read(file));
		// `files` is the whole package: a file in the folder that is not listed
		// would be missing from the install.
		assert.deepEqual(manifest.files.toSorted(), ['LICENSE', 'README.md', 'index.d.ts', 'index.js']);
	});

	it('has no dependencies to install', () => {
		const manifest = JSON.parse(read('package.json'));
		for (const key of ['dependencies', 'peerDependencies', 'optionalDependencies'])
			assert.equal(manifest[key], undefined);
		assert.doesNotMatch(read('index.js'), /^\s*import .* from/m);
	});

	it('declares every export in its types', () => {
		const types = read('index.d.ts');
		for (const name of ['Truetask', 'Database', 'ClientResponseError'])
			assert.match(types, new RegExp(`class ${name}\\b`));
		assert.match(types, /export default Truetask/);
		for (const name of ['Row', 'ListResult', 'ListOptions', 'Schema', 'SchemaField'])
			assert.match(types, new RegExp(`(interface|type) ${name}\\b`));
	});

	it('is the guide a site developer needs, in the README', () => {
		const readme = read('README.md');
		for (const method of [
			'schema(',
			'getList(',
			'getFullList(',
			'getFirstListItem(',
			'getOne(',
			'create(',
			'update(',
			'delete('
		])
			assert.ok(readme.includes(method), method);
		assert.ok(readme.includes('npm install @truetask/db'));
		assert.ok(readme.includes('<script type="module">'));
		assert.ok(readme.includes('ClientResponseError'));
		// Offline-first: a site serves the file itself.
		assert.doesNotMatch(readme.toLowerCase(), /unpkg|jsdelivr|cdn\./);
	});
});
