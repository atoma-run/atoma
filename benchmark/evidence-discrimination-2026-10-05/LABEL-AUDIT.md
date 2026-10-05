# Label correction during the first replay

The original protocol wrongly assumed that the two archived requests contained
the complete CLI source. Inspection after the first candidate response showed
otherwise: the CLI has only a short ground-truth excerpt; neither operation loop
is present. The complete test file does not prove operation order. Thus the two
archived expectedUnmet=[] labels are wrong: the defensible judgment is c3
unverified, c4 supported, with source inspection sufficient to fill the gap.

Keep the original labels, requests and raw matchesExpected results unchanged.
Report both the original scoring and this correction; do not count the original
score as an accuracy measurement. The candidate's c3 refusal is appropriate to
these supplied bytes, not evidence that a new distinguishing test is necessary.

A supplemental paired case will supply the exact final archived request plus
the immutable CLI snapshot, explicitly labelled a supplemental host read. Its
expected result is c3 and c4 supported, with order attributed to source and
arithmetic attributed to execution. This tests the missing-source explanation
without rerunning or changing the original cases.

The candidate also refused the synthetic components-positive case because its
variables jpy/kwd have no observed setup linking them to currency inputs. Keep
that original disagreement as a failed preregistered control, not a success.
A second supplemental case explicitly supplies that setup and the same literal
field assertions. This probes whether the refusal is resolved by the missing
evidence. Two supplemental cases, four calls, unchanged prompts and model.
