# Two protocol eras on one MCP route — decision record, 2026-09-30

The MCP specification revision 2026-07-28 is a new protocol generation: no
`initialize` handshake and no `Mcp-Session-Id` sessions, every request
carrying its protocol version and capabilities in `_meta`, `server/discover`,
`subscriptions/listen` in place of the GET stream and `resources/subscribe`,
no `Last-Event-ID` resumability, logging deprecated, and tasks moved out of
the core protocol into the `io.modelcontextprotocol/tasks` extension. The
TypeScript SDK v2 (`@modelcontextprotocol/server` 2.x) implements that
revision and still speaks 2025-11-25.

atoma's `/mcp` now answers both. This records why, what each era gets, and
what was rejected.

## Why both, and not only 2026

- Nobody knew which version the clients in production speak: the host did
  not record it. Claude Code 2.1.248 ships both versions; nothing showed that
  Codex, the claude.ai connectors or the other hosts had moved. Refusing
  2025-11-25 would have cut every client that has not.
- The one thing atoma's runs need from the protocol — tasks — has no server
  runtime in SDK v2 on either era, and the tasks extension had no client in
  the extension support matrix. A 2026-only server would have turned every run
  start back into a synchronous call of several minutes, on a revision that
  no longer resumes a cut stream.

So the 2025 era is kept whole, and `health().clients` now counts
`<protocol version> <client name>` for every 2025 session and 2026 request.
That count is what decides when the 2025 era can go.

## What each era gets

| | 2025-11-25 | 2026-07-28 |
|---|---|---|
| Server | one per session (`initialize`) | one per request (`createMcpHandler`) |
| Identity | bearer checked per request, session bound to its caller | bearer checked per request |
| Replay | `Last-Event-ID` over a per-session ring | none (the revision removed it) |
| Tasks | `task` on `tools/call`; `tasks/get`, `tasks/result`, `tasks/cancel`, `tasks/list` | the tasks extension: `resultType: 'task'`, `tasks/get` with the result inline, `tasks/cancel`, `tasks/update` |
| Change notifications | `resources/subscribe` per session | `subscriptions/listen`, fed by the host's run-finished events |
| Run log | `notifications/message` to the session that started the run | none: the task's status line |
| Host / Origin | checked by the host (`admitted`) | the same check |
| Deployment write freeze | judged per message | judged per message, against a server built for the caller |

The task MODEL is era-neutral (`src/mcp/tasks.ts`): a project run's task IS
the run (`project-run:<project>:<run>`, read through the tenant store and
bound to the principal and organisation that started it); operator and
benchmark tasks live in process memory, bound to their caller rather than to
a session, so a 2025 client that reconnects and a 2026 client that has no
session both find them. `src/mcp/taskWire.ts` speaks the model on each wire.

## Where the SDK had to be worked around

- SDK v2 removed `registerToolTask` and its task stores. The callback it hands
  a tool never sees `params.task`, so the task path of `tools/call` wraps the
  handler the SDK's `McpServer` installed (`installTaskProtocol`). A release
  that moves that handler map makes every server build throw, so the tests
  fail first.
- On a 2026 request the SDK refuses `tasks/get` and `tasks/cancel` with -32601
  before any handler runs, so the HTTP host answers the extension's methods
  itself (`answerModernTaskRequest`), after checking `Mcp-Method` against the
  body.
- The 2026 handler checks neither Host nor Origin; the host checks both, for
  both eras.
- A POST's era is in its body, so the host reads the body before anything
  else. A body still arriving no longer holds a session reservation. It holds
  a socket, for 30 s at most.

## Rejected

- Serving 2025 clients through the SDK default `legacy: 'stateless'`. It
  answers them with no session, which means no replay, no subscriptions, no
  run log and no GET stream, for the clients that actually connect.
- Refusing 2025 clients (`legacy: 'reject'` on the whole route). See above.
- Waiting for a server-side tasks extension in the SDK. The extension's wire
  is small, and the model was already ours after the 2026-09-30 change that
  made a project run's task the run.
- Reserving a session's place for every POST without a session while its body
  arrives. A 2026 client sends many concurrent requests and has no session;
  counting them against session ceilings would refuse it for nothing.

## Dependencies

- `zod` ^4.6.5: SDK v2 needs Standard Schema with JSON Schema, and
  `@anthropic-ai/claude-agent-sdk` already declared zod 4 as its peer.
- `@modelcontextprotocol/server` and `@modelcontextprotocol/node` for the
  server; `@modelcontextprotocol/client` as a dev dependency for the tests
  that speak 2026.
- `@modelcontextprotocol/sdk` 1.x stays for two reasons. The Claude Agent SDK
  takes a v1 `McpServer` for in-process tools (`src/core/llmClaudeCli.ts`).
  And the tests drive the 2025 era with the real v1 client, which is what
  proves that a 2025 client is served as before.
