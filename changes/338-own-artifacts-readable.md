---
section: fixed
---

- **A session can look at its own screenshots again without asking.** Since CodeDen's home became off limits, reading the `File:` path that `browser_screenshot` prints asked at every level, Full included, so factory builders and reviewers that checked their own screenshot stalled on an approval. Reading the session's own artifacts folder (`artifacts/<session id>` in CodeDen's home) now runs freely, as in its own worktree. Other sessions' artifacts, the artifacts folder itself, wildcards and searches that reach past the session's own folder, and writing or deleting there still ask.
