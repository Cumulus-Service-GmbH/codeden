---
section: added
---

- **Archiving a Docker session never deletes work that isn't pushed.** A container's clone is the only copy of its commits until they are pushed, so archive checks it first.
  - **What keeps it.** Uncommitted changes, commits on any branch that GitHub doesn't have yet, or stashes keep the container and its disk. The toast says what was found, for example "2 unpushed commits on codeden/fix".
  - **Push or delete.** **Push the branch first** pushes the branch and archives again. **Delete anyway** says plainly that the work is deleted for good.
  - **Stopped containers.** A stopped container is started to check it. If it can't be reached, it is kept and the toast says why.
  - **Projects.** Archiving a project checks each of its Docker sessions the same way and lists the containers it kept in the inbox.
