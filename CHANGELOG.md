# Changelog

## 0.1.0 - unreleased

### Added

- A database reads and writes with the methods the PocketBase JS SDK uses
- Parameters bind into a filter, so a value from a form cannot rewrite the query
- Paging that walks itself, for a whole table in one call
- A visitor identity whose own rows are the only ones it can change
- One error type carrying the status, the server's message and a retry wait
- Types in the package, no dependencies, plain ESM
- Browsers, and Node 20 and newer
