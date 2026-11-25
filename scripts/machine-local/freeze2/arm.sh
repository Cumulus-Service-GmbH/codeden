#!/bin/bash
set -Eeuo pipefail
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

stage="$(cd "$(dirname "$0")" && pwd -P)"
label=codeden.freeze2launcherpatch
directory="$HOME/.config/codeden-launcher"
target="$directory/prestart.sh"
candidate="$stage/prestart.sh"
backup="$stage/prestart.original.sh"
original_sha=bfdfd5e08865acc59142ac00371af73a3ed1573e0998327deb9e9eef59e006a0
candidate_sha=63a4580e1d8b00a823f61ded1979ae156e0ad703a23c125098debb8b22ddd5f8
app_base=a5e79dfb12851829174430c47e1768209d3ba9cc
status=starting
rollback=not_needed
scratch=
installed_identity=
exec >>"$stage/arm.log" 2>&1

log() { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
digest() { shasum -a 256 < "$1" | awk '{print $1}'; }
identity() { stat -f '%d:%i' "$1"; }

if ! mkdir "$stage/.freeze2-armed-once"; then
  log "This install has already run."
  /bin/launchctl remove "$label" || :
  exit 1
fi

restore() {
  [ "$(digest "$backup")" = "$original_sha" ] || return 1
  [ "$(identity "$target")" = "$installed_identity" ] || return 1
  [ "$(digest "$target")" = "$candidate_sha" ] || return 1
  scratch="$(mktemp "$directory/.prestart-restore.XXXXXX")" || return 1
  cp -p "$backup" "$scratch" || return 1
  [ "$(identity "$target")" = "$installed_identity" ] || return 1
  /bin/mv -f "$scratch" "$target" && [ "$(digest "$target")" = "$original_sha" ]
}

finish() {
  local code=$1 receipt
  trap - EXIT
  trap '' INT TERM
  set +e
  if [ "$code" -ne 0 ] && [ -n "$installed_identity" ]; then
    if restore; then rollback=restored; else rollback=failed_or_target_changed; fi
  fi
  if [ -n "$scratch" ] && [ -f "$scratch" ]; then rm -f "$scratch"; fi
  if receipt="$(mktemp "$stage/.install.done.XXXXXX")"; then
    printf 'exit_code=%s\nstatus=%s\napp_base=%s\nbackup_path=%s\nrollback=%s\nfinished_at=%s\n' \
      "$code" "$status" "$app_base" "$backup" "$rollback" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$receipt"
    /bin/mv -f "$receipt" "$stage/install.done"
  fi
  log "Finished with exit $code ($status, rollback $rollback)."
  /bin/launchctl remove "$label" || :
  exit "$code"
}
trap 'finish "$?"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

status=precheck
[[ -d "$directory" && ! -L "$directory" ]]
[[ -f "$target" && -O "$target" && -x "$target" && ! -L "$target" ]]
[ "$(digest "$target")" = "$original_sha" ]
[ "$(digest "$candidate")" = "$candidate_sha" ]
/bin/bash -n "$candidate"
[[ ! -e "$backup" && ! -L "$backup" ]]
original_identity="$(identity "$target")"
original_mode="$(stat -f '%Lp' "$target")"

status=backup
cp -p "$target" "$backup"
[ "$(digest "$backup")" = "$original_sha" ]
status=prepare
scratch="$(mktemp "$directory/.prestart-install.XXXXXX")"
cat "$candidate" > "$scratch"
chmod "$original_mode" "$scratch"
[[ "$(digest "$scratch")" = "$candidate_sha" && -x "$scratch" ]]
replacement_identity="$(identity "$scratch")"

status=replace
[ "$(identity "$target")" = "$original_identity" ]
[ "$(digest "$target")" = "$original_sha" ]
installed_identity="$replacement_identity"
/bin/mv -f "$scratch" "$target"
scratch=
status=verify
[ "$(identity "$target")" = "$installed_identity" ]
[ -x "$target" ]
/usr/bin/cmp -s "$candidate" "$target"
status=installed
