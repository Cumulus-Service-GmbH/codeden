---
section: added
---
- Agent sessions in a project on this computer get `TEAM_FILE`, the path of their own Team as JSON. It holds each role's provider, model and effort as chosen in CodeDen: the session's own role choice, then the project's Team, then the default Team (Settings, Factory > Team setup). It is kept current whenever any of them changes, so the review and role scripts a session runs use exactly that Team, and only for code in the project's folders.
- A new Team role, Code Reviewer Fallback (`[Code Reviewer Fallback]`), chooses the review's fallback. The factory uses it when the reviewer's provider is unavailable, after a project's wait or builder policy, and only with another provider than the author's.
- The factory's builder, scout and reviewer choices and a project manager's `start_session` now resolve the project's Team over the default Team, the same way sessions do.
