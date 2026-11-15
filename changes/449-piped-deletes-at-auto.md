---
section: security
---

- **A delete that takes its paths from a pipe now asks at Auto when they're outside the worktree.** `Get-ChildItem C:\Users | Remove-Item -Recurse` used to run without asking, because `Remove-Item` named no path of its own. CodeDen now checks the paths the command at the head of the pipeline names, or the folder it lists when it names none (`Get-ChildItem -Recurse`, `find -name x`, after a `cd`). The same applies to `… | ForEach-Object { Remove-Item $_ }` and `… | xargs rm`, and the paths `xargs rm` and such a `ForEach-Object` block name themselves are checked too. A path given as `-Path:x` or in a PowerShell list (`dist,C:\Users`) now counts for a plain `Remove-Item` as well. Piped deletes in the worktree, temp, extra folders and environment variables (`Get-ChildItem env: | Remove-Item`) still run freely.
