# Warehouse reconciliation CLI

Dependency-free Node.js 24 command-line reconciliation of an opening stock CSV and ordered event CSV.

## Usage

```sh
node stock-reconcile.js --opening <path> --events <path> --out <directory>
node stock-reconcile.js --help
```

The output directory receives deterministic `stock.csv` and `audit.json` only after the complete dataset validates. Existing outputs and both inputs are preserved on errors. Output paths cannot overwrite inputs.

CSV is UTF-8 (an optional BOM is accepted), with LF or CRLF line endings. Quoted fields support commas, doubled quotes, and embedded newlines. Headers must be exactly `sku,onHand` and `id,sku,type,quantity,ref`; records cannot have missing or extra columns. IDs and SKUs are case-sensitive and whitespace is preserved.

Opening SKUs are unique and have nonnegative safe integer stock. Event quantities are positive safe decimal integers. Events are RECEIVE (empty ref), RESERVE (new ref), RELEASE, SHIP, and RETURN. Reservation IDs are globally unique across SKUs and remain permanently unavailable after exhaustion; reservation and event IDs use separate namespaces. Reservations and references must be same-SKU and valid; availability, balances, arithmetic, and cumulative returns may not exceed safe/nonnegative limits. Event quantities are positive decimal integers (so `00` is rejected). Event IDs are global: an identical repeated parsed row is a harmless duplicate, while differing fields fail.

The audit records every event row's ID, disposition, and before/after balances, plus applied and duplicate counts. Stock rows are JavaScript-string sorted and include zero-stock SKUs. Opening-only reconciliation is supported.

## Fixed example

```sh
node stock-reconcile.js --opening examples/opening.csv --events examples/events.csv --out <directory>
```

It produces A as 9/0/9, B as 7/2/5, with six applied rows and one duplicate. The supplied `examples/excess-return-events.csv` adds a return beyond shipment quantity; it fails and leaves prior outputs unchanged.
