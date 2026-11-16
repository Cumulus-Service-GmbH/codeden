---
section: fixed
---

- **Worktree cleanup now reaches every session, not just the newest thousand.** Once a home had more than a thousand agent sessions, the hourly sweep never saw the older ones, so their worktrees stayed on disk: an archived session whose removal had failed, or a session that had been inactive for the configured number of days. Archiving a project skipped its oldest sessions in the same way. In the other direction, the check for another live session in the same folder missed sessions past the thousandth too, so archiving a session could stop such a session and remove the folder it was still working in. All three now read every session.
