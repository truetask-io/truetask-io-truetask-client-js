// =============================================================================
// @truetask/db (DEVE-1012)
// =============================================================================
// One file, no dependencies: what a website imports to read and write a
// Truetask database. A database is a board of kind `database`, and
// `/v1/db/{database}` shows it as the table it is - flat rows keyed by column
// name, a filter, a sort, paging and relation expand. This wraps those six
// routes and nothing else.
//
// The PUBLIC methods are camelCase on purpose - `getList`, `getFullList`,
// `getFirstListItem`, `getOne`, `create`, `update`, `delete`, `filter` - even
// though the rest of this repo writes JS in snake_case. They are the PocketBase
// JS SDK's names, which is what a site developer reaching for a database
// already has in their fingers, and a client that renames them would be a
// second thing to learn for no gain. Everything private below is snake_case.
//
// It holds no auth store and cancels nothing: a credential is a string the site
// hands in (a `ttdb_` database key, a `ttv_` visitor token, a personal access
// token or a session JWT), and the server decides what each one may do. That is
// why a visitor (DEVE-1014) adds one method and nothing else: minting one
// answers a token, the site keeps it and swaps the bearer string, and every
// method below works exactly as it did.

/** `per_page` the server allows at most, so `getFullList` asks for whole pages. */
const BATCH_MAX = 500;
/** What `getList` asks for when nobody says, matching the server's default. */
const PER_PAGE_DEFAULT = 30;

/**
 * Every refusal, in one shape: a non-2xx answer, a network failure and an
 * aborted request all arrive here, so a site has one `catch`.
 *
 * `status` is the HTTP status, or 0 when the request never got an answer.
 * `response` is the server's body as it came (`{detail}` from Truetask, or the
 * raw text when something in front of it answered with a page of HTML).
 * `message` is the server's `detail` when there is one, or the `message` a
 * structured detail carries (a plan refusal names its `feature` beside it).
 */
export class ClientResponseError extends Error {
	constructor({
		url = '',
		status = 0,
		response = null,
		isAbort = false,
		originalError = null
	} = {}) {
		const body_detail = response && typeof response === 'object' ? response.detail : null;
		const detail =
			typeof body_detail === 'string'
				? body_detail
				: body_detail && typeof body_detail.message === 'string'
					? body_detail.message
					: '';
		super(detail || default_message(status, isAbort, originalError));
		this.name = 'ClientResponseError';
		this.url = url;
		this.status = status;
		this.response = response;
		this.isAbort = isAbort;
		this.originalError = originalError;
		/** Seconds to wait before trying again, from the answer's `Retry-After`
		 * header. A number on a 429 that carries one, else null. */
		this.retryAfter = null;
	}
}

const default_message = (status, is_abort, original) => {
	if (is_abort) return 'The request was cancelled.';
	if (!status)
		return `Truetask could not be reached: ${original?.message || 'the request failed'}.`;
	return `Truetask answered ${status}.`;
};

// ── Binding a filter ────────────────────────────────────────────────────────

/** `{:name}`, the placeholder `filter()` binds. */
const PLACEHOLDER = /\{:\s*([A-Za-z0-9_]+)\s*\}/g;

/** A JS value as the filter grammar's own literal.
 *
 * Strings go in double quotes, where the server reads a backslash as "the next
 * character, literally" (`api/v1/_shared/db_filter.py`), so a backslash is
 * doubled and a double quote escaped; an apostrophe needs nothing. A `Date`
 * becomes its UTC day, which is the shape a date column stores. */
const bind = (value, name) => {
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error(`filter: {:${name}} is ${value}, not a number.`);
		return String(value);
	}
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) throw new Error(`filter: {:${name}} is an invalid Date.`);
		return `"${value.toISOString().slice(0, 10)}"`;
	}
	if (typeof value === 'string') return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
	throw new Error(
		`filter: {:${name}} is a ${Array.isArray(value) ? 'list' : typeof value}. A filter compares ` +
			'one value at a time: bind a string, a number, a boolean, null or a Date.'
	);
};

// ── Talking to the server ───────────────────────────────────────────────────

const query_string = (params) => {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null || value === '') continue;
		search.set(key, String(value));
	}
	const out = search.toString();
	return out ? `?${out}` : '';
};

const parse_body = (text) => {
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		// Something in front of Truetask answered instead (a proxy's error page).
		// Hand it over as it came rather than losing it.
		return text;
	}
};

/** `Retry-After` as seconds: the header is either a count or an HTTP date. */
const retry_after = (headers) => {
	const raw = headers?.get?.('Retry-After');
	if (!raw) return null;
	if (/^\d+$/.test(raw.trim())) return Number(raw.trim());
	const at = Date.parse(raw);
	return Number.isNaN(at) ? null : Math.max(0, Math.round((at - Date.now()) / 1000));
};

/** The `fetch` one call uses: its own, the client's, or the runtime's.
 *
 * The runtime's is bound to the global on the way out. A browser's `fetch` is
 * an operation ON the window, and a module is strict, so handing the bare
 * reference around is how a client ends up calling it with no receiver. */
const fetch_of = (client, options) => {
	if (typeof options.fetch === 'function') return options.fetch;
	if (typeof client.fetch === 'function') return client.fetch;
	if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
	return null;
};

const request = async (client, url, { method = 'GET', body, options = {} }) => {
	const send = fetch_of(client, options);
	if (!send)
		throw new Error(
			'No fetch to call Truetask with. On Node 18 and newer it is global; elsewhere pass one as ' +
				"`new Truetask(url, credential, { fetch })` or in a call's options."
		);
	let response;
	try {
		response = await send(url, {
			method,
			headers: {
				...(client.credential ? { Authorization: `Bearer ${client.credential}` } : {}),
				...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
				...(options.headers || {})
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: options.signal
		});
	} catch (err) {
		const aborted = err?.name === 'AbortError' || options.signal?.aborted === true;
		throw new ClientResponseError({
			url,
			status: 0,
			isAbort: aborted,
			originalError: err
		});
	}
	const text = response.status === 204 ? '' : await response.text();
	const parsed = parse_body(text);
	if (!response.ok) {
		const error = new ClientResponseError({
			url,
			status: response.status,
			response: parsed
		});
		error.retryAfter = retry_after(response.headers);
		throw error;
	}
	return parsed;
};

// ── A database ──────────────────────────────────────────────────────────────

/**
 * One database's rows. Made by `truetask.database(id)`, never directly.
 *
 * Every method takes the same `options`: `filter`, `sort`, `expand`, `fields`
 * for the ones that read a list, and `signal`, `headers` and `fetch` on all of
 * them.
 */
export class Database {
	constructor(client, id) {
		if (!id) throw new Error('database(id): a database id is the board id in its URL.');
		this.client = client;
		this.id = id;
		/**
		 * The identities this database hands out to a site's visitors
		 * (DEVE-1014). One method, because that is all a visitor is: a token
		 * minted with a key, which the site then sends in the key's place.
		 *
		 * ```js
		 * let token = localStorage.getItem('tt_visitor');
		 * if (!token) {
		 * 	const minted = await tt.database(id).visitors.create();
		 * 	localStorage.setItem('tt_visitor', (token = minted.token));
		 * }
		 * const mine = new Truetask(url, token).database(id);
		 * ```
		 *
		 * `externalId` binds the visitor to the site's own user id. It is a
		 * label and not a proof: a key in a page lets anybody send anybody's
		 * id, so bind one only when minting from your SERVER.
		 */
		this.visitors = {
			create: ({ externalId = '' } = {}, options = {}) =>
				request(client, this.address('/visitors'), {
					method: 'POST',
					body: { external_id: externalId },
					options
				})
		};
	}

	/** The address of one of this database's routes, for `fetch` and for an error. */
	address(path = '', params = {}) {
		return `${this.client.url}/v1/db/${encodeURIComponent(this.id)}${path}${query_string(params)}`;
	}

	/** The columns: each one's `name`, `type`, the parts of its `options` a
	 * client needs, and whether it is `computed` (read, never written). */
	async schema(options = {}) {
		return request(this.client, this.address(), { options });
	}

	/** One page of rows: `{page, perPage, totalItems, totalPages, items}`. */
	async getList(page = 1, perPage = PER_PAGE_DEFAULT, options = {}) {
		const url = this.address('/records', {
			page,
			per_page: perPage,
			filter: options.filter,
			sort: options.sort,
			expand: options.expand,
			fields: options.fields
		});
		return request(this.client, url, { options });
	}

	/** Every row the options match, paging until the server runs out.
	 *
	 * `options.batch` is how many rows a page asks for, 500 by default, which is
	 * the most the server gives. */
	async getFullList(options = {}) {
		const { batch = BATCH_MAX, ...rest } = options;
		if (!Number.isInteger(batch) || batch < 1 || batch > BATCH_MAX)
			throw new Error(`getFullList: batch is a whole number from 1 to ${BATCH_MAX}.`);
		const items = [];
		for (let page = 1; ; page += 1) {
			const result = await this.getList(page, batch, rest);
			items.push(...(result.items || []));
			const short = (result.items || []).length < batch;
			if (short || page >= (result.totalPages || 0)) return items;
		}
	}

	/** The first row the filter matches, or a 404 `ClientResponseError`. */
	async getFirstListItem(filter, options = {}) {
		const result = await this.getList(1, 1, { ...options, filter });
		if (!result.items?.length)
			throw new ClientResponseError({
				url: this.address('/records', { page: 1, per_page: 1, filter }),
				status: 404,
				response: { detail: 'No record in this database matches that filter.' }
			});
		return result.items[0];
	}

	/** One row by id. */
	async getOne(id, options = {}) {
		if (!id) throw new Error('getOne(id): a record id is needed.');
		const url = this.address(`/records/${encodeURIComponent(id)}`, {
			expand: options.expand,
			fields: options.fields
		});
		return request(this.client, url, { options });
	}

	/** Insert one row and get it back as the server stored it. `data` is the row
	 * itself: `title` names it, every other key is a column by name. */
	async create(data, options = {}) {
		return request(this.client, this.address('/records'), {
			method: 'POST',
			body: data || {},
			options
		});
	}

	/** Change the columns `data` names and get the whole row back. A column it
	 * does not name is left alone; `null` clears a cell. */
	async update(id, data, options = {}) {
		if (!id) throw new Error('update(id, data): a record id is needed.');
		return request(this.client, this.address(`/records/${encodeURIComponent(id)}`), {
			method: 'PATCH',
			body: data || {},
			options
		});
	}

	/** Move one row to the database's trash. Answers `true`. */
	async delete(id, options = {}) {
		if (!id) throw new Error('delete(id): a record id is needed.');
		await request(this.client, this.address(`/records/${encodeURIComponent(id)}`), {
			method: 'DELETE',
			options
		});
		return true;
	}
}

// ── The client ──────────────────────────────────────────────────────────────

/**
 * A Truetask install and the credential to talk to it with.
 *
 * ```js
 * const tt = new Truetask('https://tasks.example.com', 'ttdb_...');
 * const customers = tt.database('8cv0b1xqk2m4z7p');
 * ```
 *
 * `url` is where Truetask is served, with no trailing slash; `''` means the
 * page's own origin. `credential` is a plain string and can be replaced at any
 * time (`tt.credential = fresh`) when a session token is refreshed.
 */
export class Truetask {
	constructor(url, credential = '', options = {}) {
		if (url === undefined || url === null)
			throw new Error(
				"new Truetask(url, credential): url is where Truetask is served, or '' for this page's " +
					'own origin.'
			);
		this.url = String(url).replace(/\/+$/, '');
		this.credential = credential;
		/** A `fetch` of your own, for a runtime whose global one will not do (a
		 * SvelteKit load's `event.fetch`, a test's fake). */
		this.fetch = options.fetch || null;
	}

	/** One database by id - the board id in its URL. */
	database(id) {
		return new Database(this, id);
	}

	/**
	 * A filter with its values bound in, so no value a person typed can change
	 * what the filter asks.
	 *
	 * ```js
	 * tt.filter('Status = {:status} && Amount > {:min}', { status: 'Active', min: 10 })
	 * // Status = "Active" && Amount > 10
	 * ```
	 *
	 * A string is quoted and escaped, a number and a boolean go in bare, `null`
	 * and `undefined` become `null`, and a `Date` becomes its UTC day. A
	 * placeholder nothing binds throws, rather than travelling to the server as
	 * a filter it cannot read.
	 */
	filter(expr, params) {
		const bag = params || {};
		// One pass over the placeholders, never a substitution per parameter: a
		// value that happens to read like `{:other}` would otherwise be bound
		// again by a later round, which is the hole the binding exists to close.
		return String(expr ?? '').replace(PLACEHOLDER, (whole, name) => {
			if (!(name in bag)) throw new Error(`filter: nothing binds ${whole}.`);
			return bind(bag[name], name);
		});
	}
}

export default Truetask;
