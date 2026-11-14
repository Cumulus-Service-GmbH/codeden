---
section: changed
---

- **The factory's size check leaves out drizzle-kit's migration snapshots.** A pull request that adds a database migration no longer counts the thousands of lines of `snapshot.json` that `drizzle-kit generate` writes beside it (`<timestamp>_<name>/snapshot.json`, or `meta/0003_snapshot.json` in older drizzle-kit versions), so one migration can't push a small change over **Largest change**. The migration's SQL still counts.
