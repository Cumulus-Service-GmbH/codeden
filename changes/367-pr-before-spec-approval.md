---
section: fixed
---

- **A pull request opened before the spec was approved no longer skips the approval.** With "Approve specs before building" on, a PR found on the builder's branch while the spec waits for you or is being revised (one the agent opened with `gh pr create`, or one opened by hand) is no longer taken into review. The item stays at its approval step, its page says "A pull request was opened before the spec was approved", and the factory comments once on the PR that it waits for the approval. After you approve the spec, that PR is reviewed as usual. If the work stops before the spec is approved, the factory closes the PR with a comment.
