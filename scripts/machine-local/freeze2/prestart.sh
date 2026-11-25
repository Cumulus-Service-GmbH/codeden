#!/bin/bash
# CodeDen launcher pre-start checks.
#
# Run by "CodeDen Launcher.app" before it starts /Applications/CodeDen.app.
#  - If the CodeDen server or app is already running, the launcher just focuses it.
#  - If neither is running, log any detached runners and let CodeDen check their
#    health and ownership as it starts. A normal desktop quit leaves its runner
#    detached briefly so a new server can reconnect.
#  - A 40-second hard cap lets CodeDen start if a check hangs.
#  - Post-update checks: when CodeDen's version (CFBundleShortVersionString) differs from
#    last-version, records the new one and runs, in the background (the launch never waits for them,
#    each check is capped at 10 s): team-sync.mjs --check, a codeden-guard.mjs start_session
#    self-test and a check that CodeDen's bundle still defines start_session with its fields.
#    Results go to the log; on any failure a macOS notification is shown.
#
# Options:  --dry-run  report the checks without changing the recorded version
#           --list     print which processes the matching rules see, kill nothing, log nothing
#
# Test mode (never set by the launcher): CDL_TEST_ROOT=/tmp/<dir> swaps BOTH rules for fakes:
#   runners = "node $CDL_TEST_ROOT/.codeden/runner.js",
#   server  = CDL_FAKE_SERVER (running|none, default running). The production rules are then
#   unused, so a test can never see or kill real CodeDen processes. The post-update checks then use
#   $CDL_TEST_ROOT/last-version and $CDL_TEST_ROOT/FakeApp.app (Info.plist, Resources/app/dist), and
#   CDL_TEST_TEAM_SYNC / CDL_TEST_GUARD may point at stand-ins; notifications say "CodeDen (test)".
set -u
export LC_ALL=C   # fixed lstart / %cpu formats whatever the locale

HERE="$HOME/.config/codeden-launcher"
MATCH="$HERE/match.awk"
LOG="$HOME/Library/Logs/codeden-launcher.log"
APP="/Applications/CodeDen.app"
CD_HOME="$HOME/.codeden"
HARD_CAP=40       # absolute cap for this script
CHECK_CAP=10
NODE=""
for n in /opt/homebrew/bin/node /usr/local/bin/node; do [ -x "$n" ] && NODE="$n" && break; done
VERSION_FILE="$HERE/last-version"
APP_INFO="$APP/Contents/Info.plist"
APP_DIST="$APP/Contents/Resources/app/dist"
TEAM_SYNC="$HOME/.config/trioharness/team-sync.mjs"
GUARD="$HOME/.claude/hooks/codeden-guard.mjs"
NOTIFY_TITLE="CodeDen"

DRY=0
LIST=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --list) LIST=1 ;;
    *) echo "usage: $0 [--dry-run] [--list]" >&2; exit 2 ;;
  esac
done

MODE=prod
TEST_ROOT="${CDL_TEST_ROOT:-}"
if [ -n "$TEST_ROOT" ]; then
  case "$TEST_ROOT" in
    /tmp/?*|/private/tmp/?*) ;;
    *) echo "CDL_TEST_ROOT must be under /tmp" >&2; exit 2 ;;
  esac
  case "$TEST_ROOT" in
    *CodeDen.app*|"$CD_HOME"*) echo "CDL_TEST_ROOT must not point at CodeDen" >&2; exit 2 ;;
  esac
  MODE=test
  VERSION_FILE="$TEST_ROOT/last-version"
  APP_INFO="$TEST_ROOT/FakeApp.app/Contents/Info.plist"
  APP_DIST="$TEST_ROOT/FakeApp.app/Contents/Resources/app/dist"
  TEAM_SYNC="${CDL_TEST_TEAM_SYNC:-$TEAM_SYNC}"
  GUARD="${CDL_TEST_GUARD:-$GUARD}"
  NOTIFY_TITLE="CodeDen (test)"
fi

TAG="prestart"
[ "$MODE" = test ] && TAG="prestart TEST"
[ "$DRY" = 1 ] && TAG="$TAG DRY-RUN"

log() {
  local line
  line="$(date '+%Y-%m-%dT%H:%M:%S%z') [$TAG] $*"
  echo "$line"
  mkdir -p "$(dirname "$LOG")" 2>/dev/null
  echo "$line" >>"$LOG" 2>/dev/null
}

# Hard cap: whatever happens, this script is gone after HARD_CAP seconds.
SELF=$$
(
  sleep "$HARD_CAP"
  echo "$(date '+%Y-%m-%dT%H:%M:%S%z') [$TAG] WARNING: hard cap ${HARD_CAP}s reached, prestart aborted (CodeDen starts now)" >>"$LOG" 2>/dev/null
  kill -KILL "$SELF" 2>/dev/null   # first, so a slow notification can never extend the cap
  /usr/bin/osascript -e "display notification \"CodeDen: launcher pre-start check timed out, see ~/Library/Logs/codeden-launcher.log\" with title \"$NOTIFY_TITLE\"" >/dev/null 2>&1
) </dev/null >/dev/null 2>&1 &
CAP_PID=$!
trap 'pkill -P "$CAP_PID" 2>/dev/null; kill "$CAP_PID" 2>/dev/null; wait "$CAP_PID" 2>/dev/null' EXIT

# One snapshot of the process table, taken by ps alone (no pipe partner in it).
snapshot() { ps -axww -o pid=,ppid=,%cpu=,command= 2>/dev/null; }

# " pid pid ... " of this script and all its ancestors, excluded from runner matching.
SKIP=" "
p=$SELF
while [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null; do
  SKIP="$SKIP$p "
  p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"
done

# "pid<TAB>cpu<TAB>command" per match. $1 = server|runner, $2 = snapshot.
# The server check includes this script’s ancestors so an existing server is detected.
match() {
  local skip="$SKIP"
  [ "$1" = server ] && skip=" "
  printf '%s\n' "$2" | awk -f "$MATCH" -v kind="$1" -v mode="$MODE" -v app="$APP" \
    -v home="$CD_HOME" -v troot="$TEST_ROOT" -v skip="$skip"
}

server_running() {
  if [ "$MODE" = test ]; then
    [ "${CDL_FAKE_SERVER:-running}" != none ]
    return
  fi
  [ -n "$(match server "$(snapshot)")" ]
}

notify() { /usr/bin/osascript -e "display notification \"$1\" with title \"$NOTIFY_TITLE\"" >/dev/null 2>&1; }

# Runs "$@" for at most CHECK_CAP seconds; prints its output, returns its exit code (142 on timeout).
capped() { /usr/bin/perl -e 'alarm shift; exec @ARGV or exit 127' "$CHECK_CAP" "$@" 2>&1; }

post_update_checks() {
  local failed=0 out rc
  if [ -z "$NODE" ]; then log "post-update: node not found at /opt/homebrew/bin or /usr/local/bin"; failed=1
  else
    out="$(capped "$NODE" "$TEAM_SYNC" --check)"; rc=$?
    if [ "$rc" = 0 ]; then log "post-update ok   team-sync --check"
    else failed=1; log "post-update FAIL team-sync --check exit $rc: $(printf '%s' "$out" | head -n 5 | tr '\n' ' ' | cut -c1-400)"; fi
    out="$(capped "$NODE" "$HERE/postupdate-check.mjs" guard "$GUARD")"; rc=$?
    printf '%s\n' "$out" | while IFS= read -r l; do [ -n "$l" ] && log "post-update $l"; done
    [ "$rc" = 0 ] || { failed=1; [ "$rc" = 142 ] && log "post-update FAIL guard self-test timed out after ${CHECK_CAP}s"; }
    out="$(capped "$NODE" "$HERE/postupdate-check.mjs" bundle "$APP_DIST")"; rc=$?
    printf '%s\n' "$out" | while IFS= read -r l; do [ -n "$l" ] && log "post-update $l"; done
    [ "$rc" = 0 ] || { failed=1; [ "$rc" = 142 ] && log "post-update FAIL bundle check timed out after ${CHECK_CAP}s"; }
  fi
  if [ "$failed" = 0 ]; then log "post-update checks passed"
  else log "post-update checks FAILED, notification shown"; notify "CodeDen updated: Team checks failed, see ~/Library/Logs/codeden-launcher.log"; fi
}

# Version changed since the last launch? Record it and start the checks without waiting for them.
version_check() {
  local cur prev
  cur="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_INFO" 2>/dev/null)"
  if [ -z "$cur" ]; then log "post-update: could not read the CodeDen version from $APP_INFO"; return; fi
  prev="$(cat "$VERSION_FILE" 2>/dev/null)"
  [ "$cur" = "$prev" ] && return
  if [ "$DRY" = 1 ]; then log "CodeDen version ${prev:-<none recorded>} -> $cur: would record it and run the post-update checks"; return; fi
  printf '%s\n' "$cur" >"$VERSION_FILE"
  log "CodeDen version ${prev:-<none recorded>} -> $cur: running post-update checks in the background"
  ( trap - EXIT; post_update_checks ) </dev/null >/dev/null 2>&1 &
}

[ "$LIST" = 1 ] || version_check

if [ "$LIST" = 1 ]; then
  SNAP="$(snapshot)"
  echo "mode=$MODE"
  echo "server rule matches:"
  if [ "$MODE" = test ]; then echo "  (fake: CDL_FAKE_SERVER=${CDL_FAKE_SERVER:-running})"
  else match server "$SNAP" | cut -f1,3 | cut -c1-200 | sed 's/^/  /'; fi
  echo "runner rule matches:"; match runner "$SNAP" | cut -f1,3 | cut -c1-200 | sed 's/^/  /'
  exit 0
fi

if server_running; then
  log "CodeDen already running, cleanup skipped"
  exit 0
fi

SNAP="$(snapshot)"
RUNNERS="$(match runner "$SNAP" | cut -f1)"
if [ -z "$RUNNERS" ]; then
  log "no CodeDen server running, no leftover runner found"
  exit 0
fi

log "Detached runners$(printf '%s\n' "$RUNNERS" | sed 's/^/ /' | tr -d '\n') left running for CodeDen to reconnect"
exit 0
