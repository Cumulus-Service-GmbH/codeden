---
section: fixed
---

- **The app no longer loads every session ever on start, and live updates stay fast as sessions pile up.** The app snapshot carried every archived session, so a busy factory made each reload slower and each session update more expensive, day after day. It now carries the sessions that aren't archived plus the ones archived in the last 7 days (at most 100), and the server counts each project's archived sessions for the sidebar's "N archived" row. A project's Archived list loads 50 at a time with **Load more**. Older archived sessions still open from a link, a transcript search hit or a factory item: they are fetched when needed.
