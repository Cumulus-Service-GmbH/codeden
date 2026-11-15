---
section: security
---

- **Factory protected areas ignore case and catch renames.** Protected paths, the vision's protected areas and deploy files now match whatever the case, so a pull request that changes `.CODEDEN/project.json` or `src/Auth/login.ts` goes to a person like one that changes `.codeden/project.json` (on Windows and macOS they are the same file once checked out). A renamed or copied file is checked under its old path as well as its new one, so moving a file out of a protected folder, such as `.codeden/automations/` to `notes/`, or moving a deploy file elsewhere, is escalated too.
