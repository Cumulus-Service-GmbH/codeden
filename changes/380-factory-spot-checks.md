---
section: added
---

- **Spot-checks: a person's quick look at a share of what the factory merges by itself.** In a dark factory, much of the merged code has never been read by a person. Spot-checks set some of it aside so a person can look, and record what they find, so that risk is measured instead of assumed.
  - **Spot-check share of automatic merges** in the factory settings: 10% in a dark factory and off in a software factory, unless you set it. It picks merges by work item, so the same item always gets the same answer. Merges of work let in from an untrusted author, and of changes allowed past the size limit, are always included. 0 turns spot-checks off.
  - You get one inbox item per project, such as "3 merges to spot-check", updated as merges are set aside and resolved when none is left. You never get one item per merge.
  - The factory panel's new **Spot-checks** list shows each merge with its item, the reviewer's verdict and **Open PR**, which shows the diff in CodeDen. **Looks good** records the check. **Found a problem** records your note on the item and, unless you untick it, files it as a follow-up issue that the factory takes on.
  - The list, the daily digest and the scorecard (a new **Spot-checks** column for each builder and reviewer) show checks done, checks outstanding, and how often a person found a problem over the last 30 days.
  - Nothing waits on a spot-check: it never holds up a merge, the queue, the PRs-open limit or a drain.
  - API: `FactoryTuning.spotCheckPercent`, `FactoryItem.spotCheck`, `FactoryStatus.spotChecks`, `FactoryDigest.spotChecks` and the scorecard's `spotChecked` and `spotProblems`. `POST /api/projects/:id/factory/items/:itemId/spot-check` takes `{ verdict: "looks_good" }` or `{ verdict: "problem", note, fileIssue? }` (409 `spot_check_not_pending` when no check waits). `POST .../spot-check/file-issue` files a problem's issue later.
