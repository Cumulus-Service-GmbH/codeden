---
section: fixed
---

- **The MCP notice no longer nags about connectors and plugins you never signed into, and Dismiss sticks.** Claude Code reports every claude.ai connector and plugin server you haven't signed into as needing sign-in, in every session, so the notice under a Claude thread's header listed them every time. It now names only servers that failed and servers from your config files that need sign-in; account connectors and plugin servers waiting for sign-in show in **Details › What's loaded** only. Dismiss is remembered in this browser for the project, across sessions, reloads and remounts, and the notice comes back only for a server newly in trouble. Trouble with CodeDen's own server is still shown in each session until dismissed there.
