---
section: fixed
---

- **The inbox no longer says "You're all caught up" while it is still loading.** Opening `/inbox` directly (a notification's **Open**, a desktop deep link, a bookmark, a slow connection or a server restart) showed "0 waiting on you", zero on every filter and **You're all caught up** until the app had loaded, then the waiting items a moment later. It now shows placeholder rows and no counts until the inbox has loaded. The empty state appears only once CodeDen knows nothing is waiting, merge conflicts included. If conflicts can't be loaded, the page says so instead of claiming you're caught up. Two other views had the same problem while loading: Settings > General > Agent environment said "Add a project to choose this per project", and Usage > Budgets labelled per-project budgets "Deleted project" and said "No budgets yet". Both now wait for their data before saying either.
