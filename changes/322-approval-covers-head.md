---
section: fixed
---

- **The factory no longer merges commits pushed after the review approved.** An approval now covers the one head commit the reviewer was asked to review. When new commits land on the pull request afterwards (from the builder, a conflict resolution or anyone else), the review check goes back to waiting. The reviewer then reviews only what changed since the approved commit, and the item says why: "New commits since the approval (abc1234 → def5678): re-review running". The merge queue checks the approval again right before it merges, so a head that moves at the last moment never merges unreviewed. Merging the default branch in (Update branch), or a rebase that only brings its commits in, leaves the pull request's own changes as they were and keeps the approval, so the merge queue isn't slowed.
