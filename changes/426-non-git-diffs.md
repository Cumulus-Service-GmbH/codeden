---
section: fixed
---

- **Diffs and push for a session in a folder that isn't a git repository say why they can't answer.** CodeDen keeps no checkpoints there. The session's diff used to answer "This session has no checkpoints yet" (there never will be), and a push "Cannot push a detached HEAD". Both now answer `409 not_a_repo`, as its uncommitted diff, restore, git status and commit already did.
