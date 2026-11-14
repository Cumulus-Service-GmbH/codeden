---
section: fixed
---

- **The dark factory's scout no longer gets stuck planning a round when the factory is busy.** Planning a round waited inside the scout's tool call for each area reviewer to start or wake. Under load that took longer than the call could wait, and the round sat in planning with no reviewers until its three-hour timeout. The factory's loop for the project stalled behind it too. Now the plan is recorded and answered at once, and the area reviewers start as agents free up; asking again returns the same plan. If no agent frees up within 15 minutes, the round closes with a note in the scout's status and the next one is scheduled. A round already stuck in planning closes the same way after a restart.
