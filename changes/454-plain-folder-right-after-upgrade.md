---
section: fixed
---

- **A project that isn't a git repository reads as one from the moment CodeDen starts.** Right after upgrading, the New session view could say a session in such a project would get its own worktree, and offer Fork, Hand off and Review there, until the start-up check reached the project. CodeDen now spots a plain folder (no `.git` in it or in any folder above it) before it serves anything, without running git.
