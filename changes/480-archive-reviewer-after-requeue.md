---
section: fixed
---

- **A factory reviewer is now archived when its item goes back to the queue.** When a failure outside the work's code sends an item back to the queue because its builder is gone, the item's reviewer now becomes one of its earlier sessions along with the builder, and is archived once neither is busy. A reviewer that worked in a worktree of its own used to stay in the sidebar after the item finished, and so did its worktree.
