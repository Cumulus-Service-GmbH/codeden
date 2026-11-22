---
section: added
---

- CodeDen now defaults to four active agent sessions across projects. Extra starts and turns wait for a slot, and the cap can be changed with `limits.maxActiveSessions`. Project checks count toward the limit and start without waiting for a slot.
- Sessions resumed after a restart now wait for a free slot too, so a restart never starts more agent sessions than the limit.
- Messages from you, a project manager or the orchestrator never wait for a slot; a project manager's or the orchestrator's message to a running session goes into its turn when the agent supports it, and otherwise is the next turn.
