---
section: fixed
---

- **A busy runner no longer holds factory work back for half an hour or makes it run twice.** When the runner was too slow to answer a session's start (many agents installing dependencies at once), the factory counted it as a failure of the provider: it let the agent go, kept its reviews off that provider for 30 minutes, and refused the review of an agent that had started after all. Now a start the runner didn't answer backs nothing off. The factory waits a few minutes for the agent to show it started and carries on with it when it does. If it never starts, the factory tries again; an agent that starts after a replacement took its place is stopped and archived, so only one review counts. This covers builders, reviewers, the scout and its area reviewers.
