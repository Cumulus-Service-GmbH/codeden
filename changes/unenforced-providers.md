---
section: security
---

- **Providers the machine's security rules don't cover are off per project until you allow them.** A provider for which this machine's security rules (the guard on Claude Code sessions and Codex's execpolicy) aren't enforced (today Cursor, Gemini CLI, OpenCode and the Antigravity CLI: only Claude Code and Codex run under them) is refused for every role and session in a project, at start and as a handoff target, with the reason. Turn on **Allow providers without enforced security rules** for a project in Settings to use it there. The model picker shows such a provider as unavailable in projects that haven't allowed it.
- **Supervised and Read-only show why they're unavailable.** A provider that can't make every edit and command reach you, such as the Antigravity CLI, can't run Supervised or Read-only sessions, or a PM or the orchestrator, which are read-only; the permissions picker shows both as unavailable, with a reason that names the provider.
