---
section: security
---

- **Names-only environment listings can no longer be steered into printing values at Auto.** Three kinds of listing looked names-only but could print values, so they now ask for approval. The first cuts lines at `=` (`printenv | cut -d= -f1`, `sed 's/=.*//'`, `awk -F= '{print $1}'`, cmd's `for /f "delims==" %i in ('set') do @echo %i`): it passes on the other lines of a value that spans several, such as a private key. The second runs a `Where-Object` or `Sort-Object` script block that does more than compare, such as `{ Write-Host $_ }`, which prints every entry. The third keeps the entries in a variable (`-OutVariable v`) for a later `$v` to print. Exact listings still run freely: `compgen -e`, NUL-separated `printenv -0 | cut -z -d= -f1` (or `sed -z`), `Get-ChildItem env: -Name`, and filters that only compare names, such as `Where-Object { $_.Name -like 'CODEDEN*' }`.
