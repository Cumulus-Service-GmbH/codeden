---
section: fixed
---

- **A compaction that fails to start no longer marks the agent's next turn as a compaction.** When Codex or OpenCode couldn't start compacting, a turn the agent then started on its own, before you sent another message, was still treated as the compaction: you couldn't steer it ("The conversation is being compacted"), and the PM got no "Finished" notice when it ended. That turn is now ordinary work.
