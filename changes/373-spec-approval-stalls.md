---
section: fixed
---

- **Approved specs no longer stall the software factory, and Stop now no longer builds a spec you haven't approved.** With "Approve specs before building" on:
  - Specs you approved while **PRs open at most** was reached no longer count against each other. Before, once more of them waited than the limit allowed, none was ever built and no new work started. They are now built in the order you approved them, as many at a time as there is room for.
  - **Stop now**, or a drain that runs out of time, leaves a spec that waits for you waiting. Its agent is stopped, its inbox item stays open, and nothing is built until you approve it. Before, the spec went back to the queue, its inbox item closed, and a new agent was told to build it.
  - Approving a spec, or asking for changes, from a page or inbox card opened before the agent revised the spec is refused with "The spec changed since it was shown", and the page shows the new spec. API: the decision takes an optional `version`, the spec's `requestedAt`. A decision on any other version answers 409 `spec_changed`.
