---
section: security
---

- **The runner's browser no longer opens a debugging port.** The Chromium that holds every session's browser tabs used to listen for DevTools connections on 127.0.0.1, so any program that could reach loopback (another session's agent, another user on the machine, a container) could read every session's pages and cookies, and drive them. CodeDen now drives it only over a private pipe, and it opens no TCP port at all. The browser panel and agents work as before.
