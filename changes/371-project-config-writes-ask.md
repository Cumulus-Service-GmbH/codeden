---
section: security
---

- **Agents can't change what CodeDen runs for them.** A session's checks are fixed when it starts, read from the project's own folder and never from the session's worktree, so an agent that rewrites `checks` doesn't change what runs. An agent's edit to `.codeden/project.json` (edit tools and shell writes alike) now asks at Supervised and Auto, because its setup and check commands run in later sessions once merged.
