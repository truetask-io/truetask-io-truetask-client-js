// =============================================================================
// @truetask/db, as types (DEVE-1012)
// =============================================================================
// Hand-written on purpose. These describe ANOTHER process's answers - the rows
// and the schema `/v1/db/{database}` sends back - not the shape of any value
// this package constructs, so generating them from the code would only move the
// place the two can drift. `api/v1/db_records.py` is what they have to match.
//
// Three groups, in the order a site developer meets them: what a database's
// schema looks like, what a row looks like, and the client that fetches them.
//
// The types expect either the DOM library or Node 20's (`RequestInit`,
// `Response`, `AbortSignal`), which is every runtime this package runs in.

// ── 1. The schema ───────────────────────────────────────────────────────────

/** A column's type. The list is Truetask's own (`XATTR_TYPES`); the open end
 * is deliberate, so a column of a type added after this release still reads. */
export type FieldType =
	| 'text'
	| 'long_text'
	| 'number'
	| 'select'
	| 'select_multiple'
	| 'date'
	| 'url'
	| 'email'
	| 'phone'
	| 'checkbox'
	| 'rating'
	| 'currency'
	| 'percent'
	| 'duration'
	| 'user'
	| 'relation'
	| 'rollup'
	| 'formula'
	| 'created_on'
	| 'updated_on'
	| (string & {});

/** The parts of a column's own settings a client needs. */
export interface FieldOptions {
	/** A select's choices, as the column spells them. */
	choices?: string[];
	/** Present when the column holds several values at once. */
	multiple?: true;
	/** A rating's top mark. */
	max?: number;
	/** A currency column's ISO currency code. */
	currency?: string;
	/** What a relation column links to. */
	target?: 'card' | 'board';
	/** The database a relation column reads its records from. */
	board?: string;
}

export interface SchemaField {
	id: string;
	/** The key a row carries this column's value under. */
	name: string;
	type: FieldType;
	options: FieldOptions;
	/** A rollup, a formula or a created / updated stamp: worked out when the row
	 * is read. A computed column is only included when `fields` asks for it. */
	computed: boolean;
	writable: boolean;
	filterable: boolean;
	sortable: boolean;
	/** The board this column reads from is archived, so nothing links through
	 * it until it is restored. */
	source_archived?: true;
}

export interface Schema {
	id: string;
	name: string;
	/** The prefix a row's `key` starts with, e.g. `CUST`. */
	key_prefix: string;
	/** A People database lists the workspace's own people and takes no writes. */
	people_database: boolean;
	fields: SchemaField[];
}

// ── 2. A row ────────────────────────────────────────────────────────────────

/** A record an `expand`ed relation column resolves to. */
export interface LinkedRecord {
	id: string;
	title: string;
	key: string;
}

/**
 * One row: the five columns every record has, plus one key per column of the
 * database, named as the schema spells it.
 *
 * Values arrive as `unknown` because only the database knows its own columns.
 * Write your own type and hand it to `database()`:
 *
 * ```ts
 * const customers = tt.database<Row & { Status: string; Amount: number }>(id);
 * ```
 */
export interface Row {
	id: string;
	/** The human key, `CUST-12`. */
	key: string;
	title: string;
	/** ISO, from PocketBase: `2026-11-10 13:24:49.408Z`. */
	created: string;
	updated: string;
	/** Relation columns `expand` resolved, by column name. */
	expand?: Record<string, LinkedRecord[]>;
	[column: string]: unknown;
}

export interface ListResult<T = Row> {
	page: number;
	perPage: number;
	totalItems: number;
	totalPages: number;
	items: T[];
}

// ── 3. The client ───────────────────────────────────────────────────────────

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** What every call takes. */
export interface RequestOptions {
	/** An `AbortController`'s signal. An aborted call rejects with
	 * `ClientResponseError` whose `isAbort` is true. */
	signal?: AbortSignal;
	/** Headers added to this one call. */
	headers?: Record<string, string>;
	/** A `fetch` for this one call, over the client's own. */
	fetch?: FetchLike;
}

/** What a call that reads a list takes as well. */
export interface ListOptions extends RequestOptions {
	/** `Status = "Active" && Amount > 10`. Bind values with `truetask.filter()`
	 * rather than writing them into the string. */
	filter?: string;
	/** A column, `-` first for descending: `-Amount,Name`. */
	sort?: string;
	/** Relation columns to resolve, comma separated. */
	expand?: string;
	/** The columns a row carries, comma separated. The only way to read a
	 * rollup or a formula column. */
	fields?: string;
}

export interface FullListOptions extends ListOptions {
	/** Rows per request, 1 to 500. 500 by default, the most the server gives. */
	batch?: number;
}

/** What `getOne` takes: a single row has nothing to filter or sort. */
export interface RecordOptions extends RequestOptions {
	expand?: string;
	fields?: string;
}

/** A row on the way in: `title` names the record, every other key is a column
 * by name. A relation column takes the ids it should end up linked to. */
export type RowInput = Record<string, unknown>;

/**
 * Every refusal in one shape. A non-2xx answer, a network failure and an
 * aborted request all arrive as this.
 */
export class ClientResponseError extends Error {
	constructor(init: {
		url?: string;
		status?: number;
		response?: unknown;
		isAbort?: boolean;
		originalError?: unknown;
	});
	/** The address that was called. */
	url: string;
	/** The HTTP status, or 0 when there was no answer at all. */
	status: number;
	/** The server's body: `{detail}` from Truetask, or the raw text when
	 * something in front of it answered instead. */
	response: unknown;
	isAbort: boolean;
	originalError: unknown;
	/** Seconds to wait, from a 429's `Retry-After`. */
	retryAfter: number | null;
}

/** One database's rows. Made by `truetask.database(id)`. */
export class Database<T = Row> {
	constructor(client: Truetask, id: string);
	client: Truetask;
	/** The database's id, the board id in its URL. */
	id: string;
	/** The address of one of this database's routes. */
	address(path?: string, params?: Record<string, unknown>): string;
	/** The database's columns. */
	schema(options?: RequestOptions): Promise<Schema>;
	/** One page of rows. */
	getList(page?: number, perPage?: number, options?: ListOptions): Promise<ListResult<T>>;
	/** Every row the options match, paging until the server runs out. */
	getFullList(options?: FullListOptions): Promise<T[]>;
	/** The first row the filter matches, or a 404 `ClientResponseError`. */
	getFirstListItem(filter: string, options?: ListOptions): Promise<T>;
	/** One row by id. */
	getOne(id: string, options?: RecordOptions): Promise<T>;
	/** Insert one row and get it back as the server stored it. */
	create(data: RowInput, options?: RequestOptions): Promise<T>;
	/** Change the columns `data` names; the rest are left alone. */
	update(id: string, data: RowInput, options?: RequestOptions): Promise<T>;
	/** Move one row to the database's trash. */
	delete(id: string, options?: RequestOptions): Promise<true>;
}

export interface TruetaskOptions {
	/** A `fetch` of your own, for a runtime whose global one will not do. */
	fetch?: FetchLike;
}

/** A Truetask install and the credential to talk to it with. */
export class Truetask {
	constructor(url: string, credential?: string, options?: TruetaskOptions);
	/** Where Truetask is served, with no trailing slash. `''` is this page's
	 * own origin. */
	url: string;
	/** A `ttdb_` database key, a personal access token or a session JWT.
	 * Replace it at any time; the next call uses the new one. */
	credential: string;
	fetch: FetchLike | null;
	/** One database by id. */
	database<T = Row>(id: string): Database<T>;
	/** A filter with its values bound in, so nothing a person typed can change
	 * what the filter asks. */
	filter(expr: string, params?: Record<string, unknown>): string;
}

export default Truetask;
