# @truetask/db

Read and write a Truetask database from a website, with the methods the PocketBase JS SDK uses.

One file, no dependencies, plain ESM.
It runs in a browser and in Node 20 and newer, and it wraps one part of the API: a database's rows.

```js
import Truetask from '@truetask/db';

const tt = new Truetask('https://tasks.example.com', 'ttdb_live_...');
const customers = tt.database('8cv0b1xqk2m4z7p');

const page = await customers.getList(1, 20, {
	filter: tt.filter('Status = {:status} && Amount > {:min}', {
		status: 'Active',
		min: 10
	}),
	sort: '-Amount',
	expand: 'Contact'
});

for (const row of page.items) console.log(row.title, row.Amount);
```

A **database** is a Truetask board of kind `database`: a table with columns you define.
Its rows come back as flat objects keyed by column name, so a site reads one row in one call.

## Install

```bash
npm install @truetask/db
```

Or copy `index.js` into your own files and import it by path.
There is no CDN build and there never will be: the file is 12 KB, and a site serving it itself is one less thing between a visitor and the page.

```html
<script type="module">
	import Truetask from '/js/truetask-db.js';
</script>
```

## In a page

`/v1` answers cross-origin requests, so a page on any address can call a Truetask install directly.

```html
<ul id="rows"></ul>
<script type="module">
	import Truetask from '/js/truetask-db.js';

	const tt = new Truetask('https://tasks.example.com', 'ttdb_live_...');
	const rows = await tt.database('8cv0b1xqk2m4z7p').getFullList({ sort: 'title' });

	document.getElementById('rows').innerHTML = rows.map((row) => `<li>${row.title}</li>`).join('');
</script>
```

A credential in a page is public: anyone reading the source has it.
Give a page a credential that can do only what the page needs, which is usually reading one database.

If the page is served by Truetask itself, pass `''` as the url and calls go to the page's own origin.

## In Node, and in a server framework

Node 20 has `fetch`, so nothing else is needed.

```js
import Truetask from '@truetask/db';

const tt = new Truetask(process.env.TRUETASK_URL, process.env.TRUETASK_KEY);
const orders = tt.database(process.env.ORDERS_DB);

await orders.create({ title: 'Order 1041', Status: 'New', Total: 249.9 });
```

A framework that hands you its own `fetch` (SvelteKit's `event.fetch`, a test's fake) takes it at the client or on one call:

```js
const tt = new Truetask(url, key, { fetch: event.fetch });
await orders.getList(1, 30, { fetch: event.fetch });
```

## The database id and the credential

The **database id** is the id in its address: open the database in Truetask and it is the last part of `/board/<id>`.

The **credential** is a bearer string, and Truetask takes three kinds:

| Credential             | Where it comes from          | What it may do                                                    |
| ---------------------- | ---------------------------- | ----------------------------------------------------------------- |
| Database key (`ttdb_`) | The database's Share dialog  | Only what the key was given: one database, read or read and write |
| Personal access token  | Settings, API Tokens         | Whatever you may do, capped by the token's scope                  |
| Session JWT            | A signed-in person's session | Whatever that person may do                                       |

A database key is the one to give a website, and it arrives with the database's Share dialog.
Until that ships, a personal access token with the Read Only scope is the credential a page uses.

The server decides, every call: a credential that may only read answers 403 to a write, with a sentence saying so.
On the database itself, a board viewer reads, an editor and an admin read and write, and a guest is refused.
A People database never takes writes through the API: its rows are the workspace's own people.

Replace the credential whenever you like, for a session token that was refreshed:

```js
tt.credential = fresh_token;
```

## The methods

Every method is on a database, from `tt.database(id)`.
Every one takes `signal`, `headers` and `fetch` in its options; the ones that read a list also take `filter`, `sort`, `expand` and `fields`.

### `schema(options?)`

The database's columns, so you know what to send and what to expect.

```js
const { name, fields } = await customers.schema();
// fields: [{ id, name, type, options, computed, writable, filterable, sortable }]
```

`type` is the column's kind (`text`, `number`, `select`, `date`, `relation`, ...).
`options` carries what a client needs: a select's `choices`, a currency's code, a rating's `max`, a relation's target `board`.
A `computed` column (a rollup, a formula, a created or updated stamp) is read and never written, and it only comes back when `fields` asks for it.

### `getList(page?, perPage?, options?)`

One page of rows.

```js
const page = await customers.getList(1, 50, {
	filter: 'Status = "Active"',
	sort: '-created'
});
// { page: 1, perPage: 50, totalItems: 213, totalPages: 5, items: [...] }
```

`page` is 1 by default and `perPage` 30, with 500 the most the server gives (100 for a page that asks for a rollup or a formula column).

Every row carries `id`, `key` (the human one, `CUST-12`), `title`, `created`, `updated`, and one key per column:

```json
{
	"id": "rec0m3k1x7q9w2d",
	"key": "CUST-12",
	"title": "Acme",
	"created": "2026-11-10 13:24:49.408Z",
	"updated": "2026-11-10 13:24:49.408Z",
	"Status": "Active",
	"Amount": 1200.5,
	"Markets": ["EU", "US"],
	"Contact": ["rec7p2v8n4m1k6z"]
}
```

### `getFullList(options?)`

Every row the options match, paging until the server runs out.

```js
const all = await customers.getFullList({
	filter: 'Status = "Active"',
	sort: 'title'
});
```

It asks for 500 rows a page; `batch` changes that, from 1 to 500.
It is one call per page, so keep a filter on it for a big table.

### `getFirstListItem(filter, options?)`

The first row the filter matches.

```js
const acme = await customers.getFirstListItem(tt.filter('Email = {:email}', { email }));
```

Nothing matching is a `ClientResponseError` with status 404, so a lookup that must find something needs no check of its own.

### `getOne(id, options?)`

One row by id.

```js
const row = await customers.getOne('rec0m3k1x7q9w2d', { expand: 'Contact' });
```

### `create(data, options?)`

Insert one row and get it back as the server stored it.

```js
const made = await customers.create({
	title: 'Acme',
	Status: 'Active',
	Amount: 1200.5,
	Markets: ['EU', 'US'],
	Contact: ['rec7p2v8n4m1k6z']
});
```

`title` names the record and is required.
Every other key is a column, named as the schema spells it, matched loosely: `unit_price`, `unitprice` and "Unit price" are the same column.
Values are typed per column: a number as a number, a checkbox as a boolean, a date as `"2026-01-31"`, a select as one of its choices, a duration as `"1h 30m"` or seconds, a people column as user ids, and a relation as the ids of the records it should link to.

A write goes through Truetask the same way the app's own does, so the automations and webhooks a new row fires still fire.

### `update(id, data, options?)`

Change the columns `data` names and get the whole row back.

```js
await customers.update(made.id, { Amount: 1400, Status: 'Paused' });
```

A column the body does not name is left alone.
`null` clears a cell, and a relation column takes the full list of ids it should end up linked to (`[]` unlinks it).

### `delete(id, options?)`

Move one row to the database's trash, where it can be restored.
Answers `true`.

```js
await customers.delete(made.id);
```

## Filters

A filter is PocketBase's grammar over this database's columns:

```
Status = "Active" && Amount > 10
(Stage = "Won" || Stage = "Lost") && Owner != null
`unit price` <= 3 && Notes ~ "urgent"
```

- Operators are `=`, `!=`, `>`, `>=`, `<`, `<=`, `~` (contains, case insensitive) and `!~` (does not contain).
- Conditions join with `&&` and `||`, and group with parentheses.
- Values are `"text"`, `'text'`, a number, `true`, `false`, or `null` for an empty cell.
- `id`, `title`, `created` and `updated` are always there; every other name is a column, matched loosely.
- A column whose name has spaces goes in backticks.
- A multi select, a people column or a relation matches when any of its entries does, and a relation matches on the linked record's id.
- A rollup or a formula column cannot be filtered or sorted: read it with `fields` and compare in your own code.

A filter that cannot be read answers 400 saying what is wrong, where in the string, and which columns the database has.

### Binding values

Never write a value a person typed into the string.
`tt.filter()` puts it in for you, quoted and escaped:

```js
const where = tt.filter('Name ~ {:q} && Signed > {:since} && Owner != {:nobody}', {
	q: searchBox.value,
	since: new Date('2026-01-01'),
	nobody: null
});
// with q = O'Neil "the" boss:
// Name ~ "O'Neil \"the\" boss" && Signed > "2026-01-01" && Owner != null
```

- A string is wrapped in double quotes, with `"` and `\` escaped.
- A number and a boolean go in bare.
- `null` and `undefined` become `null`.
- A `Date` becomes its UTC day, `"2026-01-01"`, which is the shape a date column holds. For `created` or `updated` to the second, pass the string yourself.
- A placeholder nothing binds throws, instead of travelling to the server as a filter it cannot read.
- A list or an object throws: a filter compares one value at a time.

## Sorting, columns and relations

`sort` takes any stored column, with `-` in front for descending: `-Amount`, `title`, `-created,Name`.
Numbers sort numerically, dates by date, text case insensitively, and an empty cell sorts last whichever way the column runs.
The default is `created`, oldest first, so paging is stable.

`fields` trims what a row carries, by column name: `fields: 'title,Amount,Stage'`.
It is also the only way to read a rollup or a formula column, which is worked out when the row is read.

`expand` resolves a relation column to the records it points at:

```js
const row = await orders.getOne(id, { expand: 'Customer' });
row.Customer; // ["rec7p2v8n4m1k6z"]
row.expand.Customer; // [{ id: "rec7p2v8n4m1k6z", title: "Acme", key: "CUST-12" }]
```

## Errors

Everything that goes wrong rejects with one error, so a site has one `catch`.

```js
import { ClientResponseError } from '@truetask/db';

try {
	await customers.create({ Status: 'Nope' });
} catch (err) {
	if (err instanceof ClientResponseError) {
		console.log(err.status); // 422
		console.log(err.message); // "'Status': no such choice 'Nope' (choices: Active, Paused)"
		console.log(err.response); // { detail: "..." } as the server sent it
	}
}
```

| Field           | What it holds                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `status`        | The HTTP status, or `0` when there was no answer at all                                           |
| `message`       | The server's `detail`, which is written for a developer to act on                                 |
| `response`      | The body as it came: `{detail}` from Truetask, or raw text when something in front of it answered |
| `url`           | The address that was called                                                                       |
| `isAbort`       | True when an `AbortController` cancelled the call                                                 |
| `retryAfter`    | Seconds to wait, from a 429's `Retry-After`                                                       |
| `originalError` | The underlying failure, for a network error                                                       |

What the statuses mean here:

- **400** the filter, the sort, `fields` or `expand` cannot be read, or the database is too large to filter on a column.
- **401** the credential is missing, expired or not a credential.
- **403** the credential may not do this to this database.
- **404** no such database, or no such row in it. A board that is not a database says the same thing: which it is, is not a caller's business.
- **422** a value a column cannot hold, an unknown column, or a computed one. The message names the column.
- **429** too many requests. Wait `retryAfter` seconds.
- **503** something Truetask depends on is not answering.

Cancelling a call:

```js
const stop = new AbortController();
const rows = customers.getFullList({ signal: stop.signal });
stop.abort();
```

## What it does not do

- **Realtime.** There are no subscriptions: a database's rows are read when you ask for them.
- **Files.** A database has no file columns, so there is nothing to upload.
- **Anything but databases.** Boards, tasks, comments, time and the rest of Truetask are the wider `/v1` API, which this package does not wrap.

## The repository

`examples/page.html` is a customer list as one file, the page above with a search box.
`examples/every-row.mjs` writes a whole database to CSV from a shell.

`npm test` runs the unit suite on Node's own test runner, so a fresh clone needs nothing installed.

## License

MIT. See `LICENSE`.
