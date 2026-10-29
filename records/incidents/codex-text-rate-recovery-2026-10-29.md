# Codex text throttling during Attica verification

Three Attica source runs on production revision `95d1bb7c` ended after the
text transport's single retry, spaced by three seconds:

- `aa42b051-6e7b-4f08-8a37-22fcbf9243e3`: no tools executed.
- `51709f80-33b4-4a29-9d19-93ea19a138aa`: its final result review failed after
  real edits and verification. The source remained failed, with no delivery.
- `35cb3295-7750-4d7e-a178-6ba5b3694ec9`: Terra planned successfully, then
  Luna's skill prefilter and molecule plan were throttled before any tool.

All source trace pages, prompts, decoded full evidence archives, recovered
failures and runner logs were read to completion. Full initial states were
exported: 567 entries, 514 files, 9,091,219 bytes, including the 256 read-only
reference files. Each retry retained the same workspace digest
`8d1dd833637405cbb02cdeb46cd104890fca09b99a5ed8eaad2bbfc60304fd91`.
The actual runner logs and the native MCP exports matched byte hashes.

The exact failed result review answered in a separate text-only replay at
17:14:31–17:14:46 UTC; the failed molecule plan answered at
17:25:32–17:25:39 UTC, about two minutes after that source ended. Neither
replay executed tools, changed the failed source, accepted a delivery, or
switched its selected model or subscription profile. An account usage read
showed the weekly bucket at 37% used; that does not establish the absence of
other rate limits. The provider's underlying limit and its reset time remain
unknown: the transport deliberately discards diagnostic prose.

## Recovery change

A text completion whose first refusal is `rate-limited` may retry four times,
after 10, 20, 40 and 80 seconds. This is at most five subprocess attempts and
150 seconds of scheduled waiting, not an extension of the run deadline or a
guarantee about provider availability. The run signal cancels every wait.
Other transient text failures retain their one three-second retry; any later
non-transient refusal stops immediately.

Every attempt uses the original model, input, output schema and isolated
transport. Paid input/output and cache usage are summed on success, final
refusal, and cancellation during either the wait or a later child. The final
error reports the actual retry count. Only existing safe failure codes and
numeric retry progress enter logs; provider prose remains private.

The app-server tool-session recovery policy is unchanged. In particular, a
failed session that has executed a host tool cannot be replayed through a
different transport. A text retry happens before a returned action can reach
the host executor.

## Adversarial checks

Real, offline subprocesses exercise the production JSONL completion path:

- Two throttles followed by success retain all usage and the exact model/input.
- Persistent throttling stops after the fourth retry and leaves no timer.
- Cancellation while waiting spawns no further process and retains usage.
- An authentication refusal during recovery stops without another retry.
- Cancellation of an active retry reaps its real child and adds that child's
  partial usage to the first attempt's usage.

Synthetic diagnostics contain a private email and token; neither may appear
in the resulting error or recovery logs. Existing app-server tests also
exercise refusals after host tools, bounded same-thread overload continuation,
and absence of exec fallback. Checks do not call a model.

## Attica delivery status at diagnosis

The failed `51709f80` test depended on the temporary `.atoma-runs` reference.
An independent fresh copy reproduced its failure after a successful ordinary
build (`ENOENT` for that reference). Its inventory also used the older byte
reference instead of the actual iteration seed. The corrected next request
requires a portable fixture and the exact seed inventory. Passing totals in
the failed source do not establish a deliverable.

The existing hosted Attica remains on Git `887e0bb8`. At 17:18:35 UTC its API
returned 200 with 1,015 saved listings and no active collection. All six data
file hashes and permission modes matched the 14:04, 14:33 and 14:54 receipts.
No candidate was accepted or deployed over that application during diagnosis.
