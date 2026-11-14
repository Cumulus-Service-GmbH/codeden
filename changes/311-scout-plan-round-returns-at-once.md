---
section: fixed
---

- **The dark factory's scout and its area reviewers no longer time out reporting when the factory is busy.** Planning a round waited inside the scout's tool call for each area reviewer to start or wake. Under load that took longer than the call could wait, the round sat in planning with no reviewers until its three-hour timeout, and the project's loop stalled behind it. Reporting findings and filing issues also waited behind the factory's loop. Now all three are recorded and answered at once, never behind the loop, and asking again after a timeout returns the same plan or the issue already filed, or says the findings were already reported. Area reviewers start as agents free up. If no agent frees up within 15 minutes, the round closes with a note in the scout's status and the next one is scheduled. A round already stuck in planning closes the same way after a restart.
