# Bounded `edit_file` recovery for a double-escaped rename — 2026-10-06

Production run `d8bd792d-cbd1-4b79-9863-0689669de07e` attempted to rename
`internal` to `nested` twice inside one JavaScript test assertion. Its
`old_string` and `new_string` both carried two source backslashes before `n`
where the file had one. The existing error correctly diagnosed the mismatch;
the molecule then read the file and made a shorter, successful edit. This was
one failed call and one extra read before the successful call. Better wording
did not remove that round trip.

The recovery is limited to a single, exact span after one diagnostic decode.
It searches the *raw* old and new arguments for exactly one uniform identifier
rename and replays that rename against the actual span from disk. It never
decodes `new_string` or copies its surrounding bytes. Therefore genuine source
escapes and real line breaks, including a mixture of both, retain their
original bytes. The result records `recoveredFromDoubleEscape: true`.

Adversarial review of the accepted mechanism:

- Multiple decoded matches still refuse the edit; the caller has not selected
  one location. `replace_all` does not override this ambiguity.
- A replacement that also changes escapes, whitespace, punctuation, or a
  second identifier is not a uniform rename and remains a diagnostic error.
- Empty replacements, short tokens, and spans beyond the bounded search are
  excluded. They retain the ordinary exact-match behavior.
- Replacement callbacks preserve literal `$` sequences. The recovered edit
  is confined to the unique decoded span, so equal words elsewhere in the
  file are not changed.
- The probe manifest remains protected by its earlier refusal, before this
  recovery path can run.

The regression test reproduces the production assertion and checks mixed
source escapes, ambiguous matches, and an attempted escape change. It drives
the same `defaultBuiltinTools` implementation the worker uses.
