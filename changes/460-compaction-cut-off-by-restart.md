---
section: fixed
---

- **A compaction cut off by a restart no longer restarts finished work.** When the runner restarted, drained for an update or crashed during "Compact now", or during the factory's compaction between scout rounds, recovery resumed the session with "continue where you left off", and the agent ran its last task again, though it had already finished it. Recovery now leaves such a session idle, with the compaction marked "Interrupted". Messages queued behind the compaction, such as a scout's round brief, are sent next. Compacting again is up to you.
