---
section: added
---

- **A factory scorecard: which builders and reviewers produce mergeable work.** The factory panel has a new **Scorecard** section. For each builder and each reviewer, by provider and model (and for each builder and reviewer pair), it shows how their work did over the last 7, 30 or 90 days. So you can tell whether Codex builds pass review first time more often than Claude's, whether a cheaper model is good enough, or which reviewer approves work that later gets reverted. Then you can pick who builds and who reviews under **Agents** in the settings based on that.
  - The figures: work finished (merged, or failed from its own work), merges and the merge rate, **first pass** (merged with no revise round and not reverted), revise rounds per item, merges reverted after CI on the default branch failed, **cost per merge** (failures included, with the same "≈" and API-equivalent labels as the usage reports), and the median time from intake to merge.
  - Each item counts for the builder and reviewer of its last attempt, with the model their sessions ran ("default model" when none was reported). Infrastructure failures, rejected and escalated work and the factory's own reverts don't count. The scorecard is read only while the section is open.
  - API: `GET /api/projects/:id/factory/scorecard?days=7|30|90` (`FactoryScorecard`).
