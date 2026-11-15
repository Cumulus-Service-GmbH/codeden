---
section: fixed
---

- **A failed compaction no longer restarts finished work.** When "Compact now", or the factory's compaction between scout rounds, hit a usage limit or the provider process exited, automatic retry sent "continue where you left off" and the agent ran its last, already finished task again. Compaction turns are now marked as such: a failed one leaves the session idle with its error ("Compaction failed · …") and nothing retries it, so compacting again is up to you.
- **Compactions no longer wake the PM.** A finished compaction used to send the PM, and the orchestrator, a "Finished" notice and wake it, several times per scout round. Compaction turns now send no notice; normal turns notify as before.
- **Steering during a compaction is queued, not a 502.** A message sent to steer a session that is compacting (from the composer or the PM) now waits in the queue and goes once the compaction ends. A direct steer is refused with a clear message instead of a raw 502 error (Codex).
