---
section: fixed
---

- **A factory builder whose session never started now gets its brief.** When a builder's first start failed before its provider saw anything (the runner was too busy to answer, the workspace was never prepared, or the provider refused to open the session), the factory resumed it with only "pick up where you left off". The agent then had no issue, acceptance criteria or reporting steps to work from. Now such a builder counts as gone: the item goes back to the queue, and a fresh builder starts with the full brief, on whichever provider can take the work (another one when the old provider is signed out or its CLI is too old). If the old session opens late after all, it is stopped and archived, so one item keeps one agent.
