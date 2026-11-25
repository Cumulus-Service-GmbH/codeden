<!-- GENERATED: copy of ~/.config/trioharness/skill-docs/operating-rules.md written by team-sync.mjs, don't edit by hand. -->
# Operating rules

1. Never kill processes by pattern. Never use `pkill`, `killall`, or feed `pgrep` output to `kill`. Only kill PIDs your own session started.
2. Never wait or poll in the foreground for more than about five minutes. Run longer waits in the background with a timeout and let the completion notification resume your session.
3. Always pass `-o none` or `--output none` on every Azure CLI write. You may add `--only-show-errors`. Never pass another output flag.
