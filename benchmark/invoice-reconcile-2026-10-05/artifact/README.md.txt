# invoice-reconcile

Offline, dependency-free Node.js 24 CLI for synthetic accounting reconciliation. This is not jurisdictional tax advice.

## Usage

```sh
node invoice-reconcile.js --input ledger.json --out reconciliation.json
node invoice-reconcile.js --help
npm test
```

## Input contract

The root object has exactly three arrays: `invoices`, `credits`, and `payments`.

* Invoice: exactly `{id,currency,lines,taxBps}`; each line is exactly `{quantity,unitPrice}`.
* Credit: exactly `{id,invoiceId,currency,amount}`.
* Payment: exactly `{id,currency,amount,allocations}`; each allocation is exactly `{invoiceId,amount}`.

IDs and references are nonempty strings and are literal, including prototype-like names. Namespaces are independent. Supported currencies are EUR and USD (2 decimals), JPY (0), and KWD (3). Lines are nonempty; quantity is integer 1..1000000 and taxBps integer 0..10000. Decimal strings are unsigned canonical decimals: integer part 0 or nonzero digit followed by digits, optional 1..4 fractional digits, with no signs, exponents, whitespace, or leading zeros. Amounts allow at most the currency precision; JPY has no decimal point. Zero is valid. Unknown fields, missing fields, wrong types, unsupported currencies, and invalid references are rejected.

## Arithmetic and output

Each quantity×unitPrice is rounded HALF UP to minor units before subtotal summation. Tax is HALF UP(subtotal×taxBps/10000). Exact arbitrary-size integer arithmetic is used. Credits are applied in array order before payments. Payment allocations are ordered, may accumulate for an invoice, cannot exceed payment or invoice balances, and an unapplied remainder is valid.

Each input array is deduplicated by id before transitions. Equal JSON values ignoring object-key order are counted in `duplicates` and ignored; conflicting reuse is rejected. Output is exactly `{invoices,payments,duplicates}`. Invoice and payment arrays are sorted by code-unit ID order. Monetary fields are fixed-precision strings. Invoice status is `settled` at zero balance, `partial` after credit or payment, otherwise `open`. Output is deterministic and has a trailing newline. Empty arrays and zero amounts are valid.

## Safety

The complete input is validated before publishing. Output is written through a temporary file and safe replacement. Input/output identity is refused for the same path, symlink target, or hardlink; a distinct same-directory output is allowed. Malformed JSON, schema/business failures, and output I/O failures print a diagnostic to stderr, exit nonzero, and preserve input and any pre-existing output bytes.

## Tests

Run `npm test`. The suite uses real subprocesses and checks arithmetic, large values, duplicate equality/conflict-related validation, ordering, empty/prototype-like IDs, refusal preservation, identity collisions, and successful distinct output.
