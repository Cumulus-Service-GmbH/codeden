---
section: added
---

- **Run a project's agent sessions in Docker containers (experimental).** On a GitHub project's Settings tab, "Where sessions run" can be switched from this machine to Docker.
  - **One container per session.** Each new agent session gets a container of its own, with the CodeDen runner inside, and clones the repository there. Turns, files, diffs, terminals, CodeDen's tools and pull requests work as in a worktree.
  - **Restarts and archive.** A CodeDen restart picks the session up again in the same container. Archiving the session removes the container and its disk.
  - **The image.** It is built on this machine the first time (a few minutes).
  - **Hardened, with no secrets.** Containers run as a non-root user, with CPU and memory limits and no access to your files. Your GitHub token is handed to one git command at a time and is never stored in the container or its settings.
  - **Not available yet.** Agents that need a sign-in (Claude Code, Codex, OpenCode and the rest) can't run in containers until a later release, and starting one says so. The option is greyed out, with the reason and the fix, when Docker isn't installed, isn't running or is too old, and for projects that aren't on GitHub.
