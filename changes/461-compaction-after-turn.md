---
section: fixed
---

- **Compact now no longer runs the project's checks or asks for follow-ups.** With "Keep going until checks pass" on, a finished compaction ran the checks again. When they failed, it sent the agent a "checks failed" message, so compacting started a round of work you hadn't asked for. Each compaction also asked the utility model for follow-up suggestions (and a title for an untitled session) about a turn that gave no answer. Compaction turns now skip both. Work turns run their checks and get their follow-ups as before.
