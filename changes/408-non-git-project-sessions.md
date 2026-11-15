---
section: fixed
---

- **New sessions in a folder that isn't a git repository run on the first message.** They used to ask for a worktree, so the first message always failed with "… is not a git repository". The next message then ran in the project folder without saying so. Now such a project's sessions run in the project folder from the start. The New session view shows **Project folder** and lists **New worktree** disabled with the reason. A worktree asked for there (by the API, a fork, a handoff, a review or the factory) is refused when the session is created, with `not_a_repo`.
- **A session whose worktree couldn't be made no longer runs in the project folder instead.** The next message prepares the worktree it asked for again, and says why when it still can't be made.
