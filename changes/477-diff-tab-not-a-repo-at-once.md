---
section: fixed
---

- **The Diff tab of a session in a folder that isn't a git repository says so from the start.** It could show "Couldn't load the diff" for a moment, with the scope picker and Refresh, until the session's git status caught up. It now shows "Not a git repository" as soon as either the diff or the git status says the folder isn't one.
