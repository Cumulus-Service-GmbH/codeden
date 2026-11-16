---
section: fixed
---

- **The factory no longer asks a builder to rebase a pull request that already merged.** A rebase request that waited behind the builder's running turn used to be delivered after the PR merged; the builder then rebased the merged branch, and `create_pull_request` opened a duplicate PR with changes already on the default branch. When a factory PR merges or closes, the factory's requests still queued for its builder are now withdrawn. The factory also checks the PR again right before it asks for a rebase or a revise round, and sends nothing once the PR has merged or closed. `create_pull_request` from the builder of an item whose PR already merged is refused ("PR #N already merged; nothing to open") and opens no PR. Work sent back to its builder after a revert can still open its new PR.
