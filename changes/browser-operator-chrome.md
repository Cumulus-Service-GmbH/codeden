---
section: added
---

- **Browser Operator sessions start with Claude in Chrome.** A local Claude agent session whose title starts with `[Browser Operator]` now launches with Claude in Chrome turned on, so its `mcp__claude-in-chrome__*` tools load without setup. Its tool calls still ask for permission as usual, and the extension's own site permissions stay in force. Every other session, and any session on a remote runner, starts without it, and titles CodeDen writes automatically never start with a bracketed tag.
