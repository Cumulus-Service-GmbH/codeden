---
section: security
---

- **Claude Code sessions no longer show their CodeDen MCP token on the command line.** Before, the session's bearer token was in the `claude` process's command line, where any local process (and, on Linux and macOS, other users of the computer) could read it and call CodeDen as that session, a PM or the orchestrator included. Claude Code now reads its MCP servers from a private file in its own owner-only folder (`~/.codeden/runner/mcp`), deleted when the session ends. Agents ask at every level before reading another session's file, and `attach_evidence` and `share_to_chat` refuse them. No provider puts the token on a command line any more.
