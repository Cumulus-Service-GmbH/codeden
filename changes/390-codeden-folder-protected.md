---
section: security
---

- **The factory never merges changes to `.codeden/` by itself.** CodeDen's own folder holds the setup commands every new worktree runs, the checks, the vision and the scheduled automations. It is now always a protected area, built in and whatever the vision says. A pull request that changes anything there is escalated to you, naming the file and why, even with auto-merge on and every other check green. The vision file is protected wherever the project keeps it.
- **Changed setup commands ask before they run.** A new worktree starts from the freshly fetched default branch, so a merged pull request could change its `.codeden/project.json` setup without you pulling anything. Setup that differs from your own checkout's, or from a list you allowed, is now held. The first worktree that finds it asks once in the inbox, listing the commands: **Setup commands changed in #N: run them?** **Run them** allows the list for new worktrees from then on. **Don't run** keeps skipping it without asking again.
