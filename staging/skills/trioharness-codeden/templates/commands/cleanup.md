---
description: Audit and reclaim disk space for this project's worktrees (artifacts, old runs, stale locks)
---

Run the TrioHarness Lean cleanup for the current repository. Arguments: $ARGUMENTS

This command is the deliberate sweep, including the decisions a run never makes on its own (removing worktrees, deleting remote branches, deleting run folders). Routine reclaiming already happens inside every run via `reclaim.mjs` before a worktree is created and after each push, so expect the artifact numbers here to be small on an active project.

1. Resolve the repo root with `git rev-parse --show-toplevel` (if the arguments name a different project path, use that instead).
2. Resolve the script: use the `cleanup.mjs` in the trioharness-lean skill directory you loaded this command from — try `~/.codex/skills/trioharness-lean/scripts/cleanup.mjs`, then `~/.claude/skills/trioharness-lean/scripts/cleanup.mjs`. Stop and say so if neither exists.
3. Run the audit first and show the full output:
   `node <script> --repo <repo> --runs --locks`
4. Then reclaim regenerable build artifacts, unless the arguments say "audit" or "dry run":
   `node <script> --repo <repo> --apply --node-modules --locks`
5. Run folders are ledgers and evidence, not build artifacts: only when the arguments include "runs" add `--runs` to step 4, and say in the report how many folders and how much space that covers.
6. Only when the arguments include "remote-branches": first run the audit with `--remote-branches` and show the full list of deletable branches with their SHAs and the keep reasons. Deleting them is a separate step that needs the user's phrase — print it and ask for it as a blocking question; only when the user replies with exactly that phrase, rerun with `--apply --remote-branches --authorize "<phrase>"`. Never delete remote branches with a raw `git push --delete`.
7. Only when the arguments include "worktrees", add `--remove-worktrees` to step 4; otherwise never remove a worktree.
8. Report the script's final "TOTAL SPACE FREED" line verbatim, plus what was removed, anything kept and why, and any errors. Change nothing else, and never delete anything by hand — the script's own safety rules (git-tracked and git-ignored checks, merged-and-pushed checks) are the only ones that apply.
