---
section: fixed
---

- **A factory PR that adds a migration keeps its approval while the merge queue brings it up to date.** GitHub sends no patch for large files, such as every migration's `snapshot.json`, so the fingerprint of the PR's change couldn't be read, and each update-branch made the reviewer re-check "the new commits". With merges landing every few minutes, such a PR could stay approved and never merge. A file without a patch now counts by its content at the PR's head: an update-branch that leaves it alone keeps the approval, and a new version of the file still gets a re-check.
