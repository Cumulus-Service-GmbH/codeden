---
section: added
---

- **Compact now.** Session details → Context window has a **Compact now** button. The provider summarizes the conversation to free up context, so long sessions cost less per turn and stay focused on the work at hand. It runs as a turn of its own: the transcript shows "Compacting the conversation…" and then "Context compacted", and messages you send meanwhile wait until it's done. It's available for Claude Code (its `/compact`), Codex and OpenCode. Cursor and Gemini CLI can't compact on demand yet, so the button doesn't show for them. It's disabled while a turn runs or before the session has a conversation.
- **The dark factory compacts its scout and area reviewers between rounds.** These long-lived agents are reused round after round. Each one is now compacted before its next round once its context reaches 60,000 tokens (or half its context window, whichever is smaller). The new round's brief no longer sits on top of every earlier round's file reads and findings. If a compaction is refused or fails, the round goes ahead as before.
- API: `POST /api/sessions/:id/compact`, which answers `409` with `turn_running`, `unsupported`, `not_started` or `archived` when the session can't compact now. `ProviderCapabilities` gains an optional `compact` flag, and the runner gains a `session.compact` command.
