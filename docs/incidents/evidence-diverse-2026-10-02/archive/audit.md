# Warehouse ledger reconstruction audit

## Observations and raw candidates

The stated reliable opening stock is **40 boxes**. The five consecutive movement observations are preserved here without choosing among OCR alternatives:

- t1 receipt: {+12, +17}
- t2 dispatch: {-9, -4}
- t3 receipt: {+6, +8}
- t4 dispatch: {-15, -13}
- t5 receipt: {+10, +16}

Reliable checkpoint observations are stock after t3 = **54** and stock after t5 = **51**. These are the supplied observations and constraints; no source document or historical claim is added.

## Constraints

For a sequence (t1, t2, t3, t4, t5), start at 40, add each signed candidate in order, require every intermediate balance to be nonnegative, require balance after t3 to equal 54, and require balance after t5 to equal 51.

## Surviving alternatives

Exactly two sequences survive:

1. (+12, -4, +6, -13, +10)
2. (+17, -9, +6, -13, +10)

The alternatives differ only at t1 and t2.

## Arithmetic for every surviving five-movement sequence

- Sequence 1: 40 + 12 = 52; 52 - 4 = 48; 48 + 6 = 54; 54 - 13 = 41; 41 + 10 = 51. Balances: (52, 48, 54, 41, 51). All are nonnegative.
- Sequence 2: 40 + 17 = 57; 57 - 9 = 48; 48 + 6 = 54; 54 - 13 = 41; 41 + 10 = 51. Balances: (57, 48, 54, 41, 51). All are nonnegative.

## Identifiable movements and balances

Across all surviving sequences, the identifiable movement values are t3 = +6, t4 = -13, and t5 = +10. Identifiable balances are after t2 = 48, after t3 = 54, after t4 = 41, and after t5 = 51.

## Ambiguous movements and balances

t1 remains ambiguous between +12, +17. t2 remains ambiguous between -9, -4 (paired with t1 as shown above). The balance after t1 remains ambiguous between 52 and 57. No other balance is ambiguous.

## Resolved values versus plausible guesses

A **resolved value** here means a value shared by every surviving candidate sequence or a supplied reliable observation: t3 +6, t4 -13, t5 +10, balances 48/54/41/51, opening 40, and checkpoints 54/51. A **plausible guess** is an unverified choice among surviving alternatives, such as choosing t1 +12 (and t2 -4) or choosing t1 +17 (and t2 -9). This audit makes no such choice: both alternatives remain reported, and a plausible guess must not be treated as resolved evidence.
