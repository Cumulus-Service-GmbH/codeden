---
section: security
---

- **Moving code into `docs/` no longer skips the factory's review.** The merge checks now count a renamed or copied file under its old path as well as its new one. Before, a pull request in the docs pipeline that moved `apps/server/src/x.ts` to `docs/x.md` looked docs-only and merged without the independent review. Now it is reviewed and needs tests and test results like any other code change. Moving a UI file elsewhere now needs screenshots, and moving code into a vendored or generated folder still counts towards the size limit.
