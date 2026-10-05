# Offline stock reservation service

Dependency-free Node.js 24 HTTP service using durable SQLite (`node:sqlite`).

## Run

    node server.js --db DB --seed SEED.json --port PORT

The server binds to 127.0.0.1, accepts port 0, and prints `{"port":actualPort}` after binding. Requests use `http://localhost:<port>`. A new database is initialized from `{"items":[{"sku":"A","capacity":10}]}`; an existing database retains state and receipts.

## API

`GET /state` returns deterministic logical clock, revision, sorted items, and holds. `POST /commands` accepts reserve, confirm, cancel, and advance commands. Successful commands return 200; business refusals return 409 and are idempotently cached. Invalid schemas return 400 and are not cached. Domain mutations and receipts commit transactionally.

## Tests

Run:

    npm test

The real HTTP subprocess suite exits 0 and asserts strict malformed/missing/extra/type/range validation (including invalid `type:["advance"]` and `__defineGetter__`), repeated-line aggregation and atomic rollback, confirm/cancel and inclusive expiry ordering, concurrent last-unit contention and duplicate-key replay, object-order idempotency and array-order conflicts, Unicode code-unit ordering, literal prototype-like keys, and SIGKILL/restart persistence for successful and refused receipts.
