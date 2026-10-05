# Stock reservation service

## Prerequisites
Node.js 24 or newer, with the built-in `node:sqlite` module. No npm dependencies are required.

## Run
```sh
node server.js --db DB --seed SEED.json --port PORT
```
The server binds only to 127.0.0.1, accepts port 0, and prints one readiness JSON line `{"port":actualPort}`. HTTP examples use the placeholder `http://localhost:<port>`; the equivalent marker placeholder is `LISTENING_ON_PORT=<port>`.

A seed is exactly `{"items":[{"sku":"A","capacity":10}]}`, with unique nonempty string SKUs and integer capacities from 0 through 1000000. It is consumed only when the database is new.

## API
`GET /state` returns exactly `{clock,revision,items,holds}`. Items contain `sku,capacity,available`; holds contain `id,expiresAt,status,lines`, with statuses held, confirmed, cancelled, or expired. Items, holds, and lines use JavaScript code-unit ordering. Reads are byte-stable and do not mutate state.

`POST /commands` accepts exact schemas:
- reserve: `{key,type:"reserve",holdId,ttl,lines:[{sku,qty}]}`
- confirm/cancel: `{key,type:"confirm"|"cancel",holdId}`
- advance: `{key,type:"advance",to}`

Integers and ranges follow the contract (ttl/qty 1..1000000; advance 0..1000000000). Reserve aggregates repeated SKUs and is all-or-nothing. Advance expires held reservations when `expiresAt <= to`. Confirm consumes stock; cancel releases it. Successful commands return 200 `{"ok":true,"revision":N}`; business refusals return 409 with the documented error codes. Schema or JSON errors return 400 `{"error":"invalid"}`.

Each valid key caches its first complete response durably. Retries compare commands ignoring object-key order while preserving array order. Changed commands return `idempotency_conflict`; invalid requests are not cached. SQLite transactions commit domain changes and receipts together, and an in-process command queue serializes concurrent requests. State and receipts survive process termination and restart.

## Test
```sh
npm test
```
The test uses real child Node HTTP processes and temporary files and exits nonzero on assertion failure.
