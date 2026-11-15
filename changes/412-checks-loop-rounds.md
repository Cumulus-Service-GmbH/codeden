---
section: fixed
---

- **"Keep going until checks pass" stops at its round limit for good.** The round count used to start again after any turn the user's message didn't start: Compact now, or the automatic "continue" after a usage limit, a failure or a restart. A session that kept hitting usage limits could loop unattended with no end. The count now lives on the session. Only a new message (from you, a PM or the factory) or switching the loop off and on starts it again. Turns CodeDen starts itself never do. Once the checks still fail after the last round, they don't run again until one of those happens.
- **Compact now waits for running checks.** While the project's checks run after a turn, **Compact now** is disabled with the reason. The API refuses it with `checks_running`, so the run and its results are kept.
- **A check that leaves a process in the background finishes.** A check that started a server or watcher in the background never ended, and every later check for that session was refused until the runner restarted. A check now ends when its own process exits, and whatever it left running is killed with it. Stop and the timeout always end a check, even once its shell has exited. A check that a CodeDen restart cut off is cancelled on the runner when the runner reconnects.
