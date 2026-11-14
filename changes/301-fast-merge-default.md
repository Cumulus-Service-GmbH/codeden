---
section: changed
---

- **Factories with auto-merge on now use the Fast merge policy by default.** This includes existing projects. A queued pull request that is behind the default branch merges on its own CI when nothing it changed moved there. To keep re-testing every pull request against the default branch before it merges, set **Merge policy** to **Strict** in the factory's Limits.
