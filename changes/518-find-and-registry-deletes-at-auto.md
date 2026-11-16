---
section: security
---

- **`find` and `fd` deletes outside the worktree, and registry deletes, now ask at Auto.** `find ~/projects -name '*.log' -delete`, `find ~/Documents -type f -exec rm {} \;` (also `-exec rm -rf {} +`, `-execdir`, `-ok`) and `fd . ~/old -x rm` used to run without asking. CodeDen now treats them like `find ~/projects | xargs rm`: they delete in the folders they search, or in the current folder when they name none. `Remove-Item HKCU:\Software\Foo -Recurse` also ran freely, because the registry key looked like a relative path in the worktree. Deleting registry keys and values and certificates (`HKLM:\…`, `Registry::…`, `Cert:\…`, `Remove-ItemProperty`, `reg delete`) now always asks. Deletes in the worktree and temp, and of the shell's own `Env:`, `Variable:`, `Function:` and `Alias:` drives, still run freely.
