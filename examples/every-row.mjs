// Every row of a database, to a CSV on stdout. Node 20 and newer:
//
//   TRUETASK_URL=https://tasks.example.com TRUETASK_KEY=ttdb_live_... \
//     node examples/every-row.mjs <database id>
//
// `getFullList` pages until the server runs out, 500 rows at a time, so it is
// one call per page and not one per row.
import Truetask, { ClientResponseError } from '../index.js';

const [database] = process.argv.slice(2);
if (!database) {
	console.error('usage: node examples/every-row.mjs <database id>');
	process.exit(2);
}

const tt = new Truetask(process.env.TRUETASK_URL, process.env.TRUETASK_KEY);
const rows_of = tt.database(database);

const cell = (value) => {
	const text = value === null || value === undefined ? '' : String(value);
	return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

try {
	const { fields } = await rows_of.schema();
	const columns = ['key', 'title', ...fields.filter((f) => !f.computed).map((f) => f.name)];
	const rows = await rows_of.getFullList({ sort: 'created' });
	console.log(columns.join(','));
	for (const row of rows) console.log(columns.map((name) => cell(row[name])).join(','));
	console.error(`${rows.length} rows`);
} catch (err) {
	if (!(err instanceof ClientResponseError)) throw err;
	console.error(`${err.status}: ${err.message}`);
	process.exit(1);
}
