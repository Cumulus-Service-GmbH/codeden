---
section: added
---

- **Hook runs show in the transcript.** When a hook from your settings runs during a Claude Code or Codex session, its turn shows a one-line row for it: the event, what ran, how it ended (ran, failed, blocked or cancelled), the exit code when known and how long it took. Click the row to see the hook's output and its settings file. A `PreToolUse` hook that blocks a tool, a `Stop` hook that keeps the agent going and a formatter that fails now stand out as warnings with their reason, so you can see why an agent behaved the way it did. Successful runs stay inside the turn's group of tool calls, and runs that succeed one after another fold into one "3 hooks ran" row. **What's loaded** says when a session's hook runs show this way. Other providers are unchanged.
