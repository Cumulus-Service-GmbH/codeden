---
section: added
---

- Flag commands that have been running for 15 minutes and remind agents to wait in the background so they can respond to new messages.
- Show how long a priority message has been waiting for a shell call. After two minutes by default, providers that support tool-only cancellation can stop a simple shell wait and deliver the message.
- Keep priority messages in the outbox while they wait so a server restart preserves them.
- Preserve the current composer draft when a priority send is cancelled.
