---
section: fixed
---

- **Project checks on Windows no longer wait a second or two after they finish.** After each check, CodeDen lists every running process to end anything the check left running in the background, such as a server or a watcher. On Windows that listing takes a second or two, and the check's result used to wait for it even when the check left nothing behind. The result now comes as soon as the check's output is complete, and anything it left running is still ended.
