---
section: security
---

- **Agents can no longer read CodeDen's own home without asking.** Reading, listing, copying or searching anything in `~/.codeden` (or your `CODEDEN_HOME`) now asks at every permission level, Full included, and is refused for Read-only sessions, PMs and the orchestrator. This covers the database with every session's transcript, settings, logs, backups and other sessions' worktrees, not only the install token and runner lock as before. A session's own worktree there works as usual. Every agent, PM and factory brief now also tells agents to get CodeDen's state from its MCP tools instead.
