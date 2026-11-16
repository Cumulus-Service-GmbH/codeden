---
section: fixed
---

- **Approved work over its per-item spend cap merges instead of getting stuck.** The review is often the turn that takes an item over its cap, so the cap failed pull requests that had passed every check and only had to merge. The cap now stops agent turns, not the steps that cost nothing: work in verification that is over its cap still waits on CI, joins the merge queue, is brought up to date by GitHub and merges. It stops as stuck only before a step that would start an agent turn (a revise round, a review or re-review, a rebase or integrator), with a note saying why. Its sessions still at work are stopped, and work in the queue or building stops at the cap as before.
