---
section: fixed
---

- **Sessions without a worktree have the right panel again.** A session that runs in place, in a project folder that isn't a git repository or started in the project folder, now has the right-panel toggle and `Ctrl \`. Subagents, the browser, files, the terminal and details all work in the session's folder, and a subagent card's **Open** shows the subagent beside the transcript. In a folder without git, the Diff tab says "Not a git repository" instead of waiting for checkpoints that never come, and Details shows the folder the session runs in.
  - Runner: a git command in a folder outside any repository fails with `not_a_repo` instead of `git_failed`, and the server answers it with `409 not_a_repo`.
