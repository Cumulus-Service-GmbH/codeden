---
section: security
---

- **Require approval at every permission level.** A PreToolUse hook from your Claude settings can start its "ask" reason with `[approval-required]`. CodeDen then offers only Allow once and Deny at every permission level and never remembers the answer.
