# Code review index

General reviews are listed by the code window they examined, not by the date
of the last documentation edit. A retired report remains addressable in Git.
For the next review, start at the last examined revision below and inspect
subsequent corrective commits as well.

Report files live in the [documentation archive](archive/README.md#reviews).
Moving a report does not change the revision it examined or the next review's
starting point.

- **2026-10-09** — [report](archive/reviews/code-review-2026-10-09.md) and
  [reproduction evidence](incidents/code-review-2026-10-09-evidence.md).
  Window `cc631bb6..c07e3548`, 275 commits, including the closure commits
  (`0b02fa7c`, `48afbb4e`) of the previous review, whose findings it
  re-examines in section 6. Owner decisions are listed in section 3.
- **2026-10-02** — [report](archive/reviews/code-review-2026-10-02.md) and
  [reproduction evidence](incidents/code-review-2026-10-02-evidence.md).
  Window `149f141..cc631bb6`, 170 commits, including the closure commits
  (`654c404`..`c252885`) of the previous review, whose findings it re-examines
  in section 6. Corrective work and remaining owner decisions are tracked in
  section 9.
- **2026-09-25** — [report](archive/reviews/code-review-2026-09-25.md) and
  [reproduction evidence](incidents/code-review-2026-09-25-evidence.md).
  Window `923bbab..149f141`, 31 commits, including the closure commit
  `159ab36` of the previous review, whose five findings it re-examines.
- **2026-09-24** — [report](archive/reviews/code-review-2026-09-24.md) and
  [reproduction evidence](incidents/code-review-2026-09-24-evidence.md).
  Window `01ed50c..923bbab`, 343 commits. Corrections and their verification
  are recorded in the report's closure section.
- **2026-08-27** — window `4459dc0..01ed50c`, 169 commits.
  Report committed in `2892ac2`, closure ledger in `f1c937d`.
  Read with `git show f1c937d:docs/code-review-2026-08-27.md`.
- **2026-08-20** — window `c517b8e..4459dc0`, 69 commits.
  Report committed in `8545814`, later closure ledger in `dc6c079`.
  Read with `git show dc6c079:docs/code-review-2026-08-20.md`.
  Both August 20 and August 27 reports were retired by `4766f8a`; this does
  not move the next review's starting point back to August 18.
- **2026-08-18** — [report](archive/reviews/code-review-2026-08-18.md), window
  `027ae42..08fc043`, 104 commits.
- **2026-08-14** — [external review](archive/reviews/code-review-2026-08-14.md),
  August 4–14, 296 commits; examined `a56ee0c` plus the then-current worktree.

Focused design reviews, including [A1 attestation](archive/reviews/supervisor-attestation-a1-review-2026-08-22.md)
and [platform skill offers](archive/reviews/platform-skill-offer-review-2026-08-23.md), do not
replace a general code review's baseline.
