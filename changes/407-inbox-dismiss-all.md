---
section: added
---

- **Dismiss a whole inbox view at once.** The inbox header has a **Dismiss N** button for the notices in the current tab: factory decisions, pull requests ready for review, failed runs, digests and results. A short confirmation names what stays ("57 notices will be dismissed; 3 items that wait on you stay"), and the toast offers **Undo** for 10 seconds, which brings back exactly the items it dismissed. The button also fits the header at phone width.
  - **What waits on you is never dismissed in bulk.** That means questions and approvals (an MCP server's form included), specs to approve, changed setup commands, start conflicts, triage decisions, and high-priority items that need a person: a regression or a revert that can't merge, a paused factory loop, stuck work, a decision flagged for you, an escalated pull request, a budget passed. You can still dismiss each of them one at a time. The server applies the same rule, whoever asks.
  - Dismissed items act exactly like ones you dismissed by hand: counts, badges and notifications update. The failed runs group's **Dismiss all** gets the same Undo.
  - API: `POST /api/inbox/dismiss` takes `ids` (at most 1000) or a `filter` (`projectId`, `sessionId`, `kinds`) and answers with the ids it dismissed and how many items it `kept`. `POST /api/inbox/restore` undoes it, and `inboxWaitsOnYou` is the shared rule.
