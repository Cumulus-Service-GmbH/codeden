---
section: added
---

- **See which MCP servers connected, which failed and which need sign-in.** Claude Code and Codex sessions now report each MCP server's live state, and **Details › What's loaded** shows it beside every server: connected, starting, failed, needs sign-in or disabled, with the provider's error on hover. Servers the provider runs that aren't in your config files (plugins, connectors) are listed too. When a server failed or needs sign-in, a notice under the session's header names it and says how to fix it, and goes away once it connects. CodeDen's own server is covered the same way. Only server names, states and a short, masked error are kept, never a server's config. Other providers list their configured servers as before.
