---
name: project-chat-acceptance
description: "2026-10-12 owner chose the project conversation as the one acceptance surface for runs started anywhere; selection rule, layout fixes, open owner questions from that day's production tests"
metadata:
  node_type: memory
  type: project
  originSessionId: 2dbc7e75-23ed-4085-a06e-0a1338d0e1f7
  modified: 2026-10-12T15:15:33.319Z
---

On 2026-10-12 the owner reported that a run started over MCP said "awaiting acceptance" while the project page offered no way to accept it. Asked where acceptance should live, they chose **the project conversation** (over a Runs-tab button or the result reader).

Shipped and deployed the same day:
- c3fe05ee: the chat card follows project runs, not only `conversation.lastRun`.
- 42ae89f2: a chat with no messages keeps its natural height beside a run. The owner had found it "très grand et très vide".
- 3b23a747: spacing above the review form.
- 5c688062: selection order is a live run's status, else the newest delivery awaiting acceptance (looking past comparison reruns, stopping at a settled delivery), else the newest run.

**Why:** a later cancelled run or comparison rerun had hidden the delivery to accept. That was measured on 3069ac59 and 81b998a0.

**How to apply:** acceptance still always publishes file deliveries. The owner asked about "accept without GitHub" and did not decide; offer it as a product decision, don't build it unasked.

The open owner questions raised that day:
- Text deliverables show the L1 `== GROUND TRUTH ==` evidence block to the client as part of the answer.
- L3 `gpt-6-astra` planning costs $0.12–0.25 per run. One comparison rerun on terra delivered at $0.085 vs $0.20, but its server served its data file and its source. Settling this needs a pre-registered measurement, not one sample.

Also learned: `viz:smoke` (outside CI) had rotted since ~2026-10-08 and was repaired in 6e203043. Run it before every viz push, as AGENTS.md says. Related: [[mcp-review-2026-10-03]], [[verification-speed]].
