---
section: security
---

- **A change to an automation's file no longer keeps it running.** When the `.codeden/automations/` (or `~/.codeden/automations/`) file of an automation that's on changes its schedule, prompt, permissions, agent or guards, CodeDen switches it off and your inbox shows the change as a diff: "Automation *name* changed in its file: review and turn it back on". A new name or description keeps it on.
- **Automations never run above the permission level you approved.** Switching one on records its level; scheduled, event and PM-started runs are capped at it, so a file that later asks for Full runs at what you approved until you switch it on again.
- **Agents ask before editing CodeDen's automation files and vision.** Writes to `.codeden/automations/` and `.codeden/VISION.md` now ask at Supervised and Auto, like `.codeden/project.json`.
