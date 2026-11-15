---
section: changed
---

- **The factory merges pull requests seconds apart instead of one CI run apart.** With auto-merge on, every pull request that passed its checks now merges on the same check of the loop, oldest approved first. Before, the merge queue took one step per check and re-tested most pull requests against the default branch first, so five green pull requests could take half an hour.
  - **A pull request that is behind the default branch merges on its own green CI**, the way it would if you merged it on GitHub yourself. GitHub reports conflicts, and CI on the default branch is still watched after every merge: a merge that breaks it is reverted.
  - **It is re-tested first only for a clash Git can't see:** the pull request and the commits it is missing both changed dependency files (lockfiles, `package.json`), or both changed database migrations. A shared barrel (`packages/*/src/index.*`), a CI workflow, build config or a file both sides touched no longer forces a re-test.
  - **A waiting pull request no longer blocks the queue.** One whose CI is still running, or that waits for a re-review, is passed over, and the ready ones behind it merge.
  - **Re-tests run side by side**, and the other pull requests keep merging meanwhile. A pull request that changes the same kind of files as one being re-tested waits for it ("merges after #12") instead of being re-tested twice.
  - The **Strict** merge policy, a red default branch and branch protection that requires up-to-date branches still re-test every pull request, one at a time.
  - A pull request GitHub refuses to merge for a reason other than being behind now counts toward the three refusals that take it out of the queue, also when other pull requests merged in between.
