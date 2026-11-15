---
section: added
---

- **Keep going until checks pass.** List your project's checks in `.codeden/project.json` (`"checks": ["pnpm typecheck", { "command": "pnpm test", "timeoutSec": 900 }]`). The New session view and a session's composer then offer **Checks**. Turn it on and CodeDen runs the checks in the session's worktree after each turn. Failing commands go back to the agent with their exit code and the end of their output, and the agent fixes them in another turn, up to a round cap (3 by default). Each run appears in the transcript as a card with each check's result, duration and output, plus Stop while it runs. Stop or a new message ends the loop, and reaching the cap leaves the session waiting for you. Session details lists the commands the session runs.
