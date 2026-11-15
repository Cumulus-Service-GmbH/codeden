---
section: security
---

- **Commands run by a cmd `for` loop now ask for approval at Auto like the same commands on their own.** The command a `for /f` loop reads, such as `for /f "tokens=*" %i in ('set AWS') do @echo %i`, ran freely, because the quoted command was read as a single word. This loop prints every variable whose name starts with `AWS`, values included. The command is now judged on its own, and so are the files `for /f` reads (`for /f %i in (.env) do @echo %i`) and the command after `do` (`for %i in (1) do set AWS`). cmd's `@` before a command (`@set AWS`) no longer hides it either. Loops that print no values, such as `for /f %i in ('git rev-parse HEAD') do @echo %i`, still run freely.
