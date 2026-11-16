---
section: fixed
---

- **`Pop-Location` and `popd` no longer make a later command in the worktree ask at Auto.** `Push-Location HKCU:\Software; Pop-Location; Remove-Item dist -Recurse` asked with "Deletes dist, outside the worktree", because the location never went back. `pushd` and `Push-Location` now keep a stack that `popd` and `Pop-Location` return to.

