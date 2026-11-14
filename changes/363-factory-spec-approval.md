---
section: added
---

- **Approve a feature's spec before the software factory builds it.** Turn on **Approve specs before building** in the factory settings (off by default) and every feature stops after Analyze until you have read its spec. A misunderstood request then costs a short spec instead of a build, a review and a revise round.
  - The spec and its acceptance criteria are posted on the issue as before. You also get an inbox item **Approve the spec** with the spec in it, and the item appears in the Factory view's **Needs you** lane and the daily digest's **Waiting on you**.
  - **Approve spec** (on the item page or the inbox card) has the agent build it. **Request changes** sends the agent your note; it revises its analysis, and the new spec waits for you again. Both decisions are posted on the issue.
  - While a spec waits, nothing runs: the agent holds no agent slot and is never reminded or failed for waiting, and the item counts neither toward **PRs open at most** nor toward a drain (**Finish current work, then stop**). A spec nobody reads never blocks other work.
  - A dark factory never waits on you, so it skips the step. Turning the setting off approves the specs still waiting.
  - API: `FactoryTuning.specApproval`, `FactoryItem.specApproval`, `FactoryWorkItem.specApproval`, the `approve_spec` need, and `POST /api/projects/:id/factory/items/:itemId/spec` with `{ decision: "approve" }` or `{ decision: "request_changes", feedback }` (409 `spec_not_pending` when the spec doesn't wait).
