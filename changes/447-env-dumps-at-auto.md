---
section: security
---

- **More ways of dumping the environment now ask for approval at Auto.** Until now only `printenv` and `Get-ChildItem env:` asked. Bare `env`, `export -p` and `declare -x`, `set` (in POSIX shells, and cmd's `set` and `set NAME`, which lists every variable starting with NAME), `[Environment]::GetEnvironmentVariables()`, `node -e`, `bun -e`, `deno eval` and `python -c` code that prints `process.env` or `os.environ` whole, and reading `/proc/self/environ` (any process's `environ`, from the shell or the Read tool) ask too. Running a command through `env` (`env -u NAME pnpm test`), setting variables (`export NAME=…`, cmd's `set NAME=…`), shell options (`set -euo pipefail`), single variables (`process.env.NODE_ENV`, `os.environ.get("HOME")`), names-only listings (`compgen -e`, `env -0 | cut -z -d= -f1`, `Object.keys(process.env)`) and searches for `process.env` still run freely.
