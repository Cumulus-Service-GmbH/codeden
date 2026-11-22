---
section: added
---

- CodeDen now defaults to four active agent sessions across projects. Extra starts and turns wait for a slot, and the cap can be changed with `limits.maxActiveSessions`. Project checks count toward the limit and start without waiting for a slot.
- Sessions resumed after a restart now wait for a free slot too, so a restart never starts more agent sessions than the limit.
