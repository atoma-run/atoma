# Offline stock reservation service

Dependency-free Node.js 24 HTTP service using durable SQLite (`node:sqlite`).

## Run

    node server.js --db DB --seed SEED.json --port PORT

The server binds to 127.0.0.1, accepts port 0, and prints `{"port":actualPort}` after binding. Requests use `http://localhost:<port>`. A new database is initialized from `{"items":[{"sku":"A","capacity":10}]}`; an existing database retains state and receipts.

## API

`GET /state` returns deterministic logical clock, revision, sorted items, and holds. `POST /commands` accepts reserve, confirm, cancel, and advance commands. Successful commands return 200; business refusals return 409 and are idempotently cached. Invalid schemas return 400 and are not cached. Domain mutations and receipts commit transactionally.

## Tests

`npm test` runs real HTTP subprocess tests. It covers strict validation, aggregation and atomicity, lifecycle and expiry, idempotency, ordering, contention, and restart persistence.
