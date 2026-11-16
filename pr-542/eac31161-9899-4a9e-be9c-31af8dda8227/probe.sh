#!/usr/bin/env bash
# Runs the CI step's two checks against the stand-in server the way GitHub's bash runs a step
# (bash -eo pipefail): first as written in ci.yml (curl | grep -q), then writing to a file first.
P=4791
TOKEN=t
runs=${1:-20}
count() {
  local n=$1 ok=0 bad=0 codes=""
  for i in $(seq 1 "$n"); do
    bash -eo pipefail -c "$2" 2>/dev/null; c=$?
    if [ $c -eq 0 ]; then ok=$((ok+1)); else bad=$((bad+1)); codes="$codes $c"; fi
  done
  [ ${#codes} -gt 60 ] && codes="$(echo $codes | tr ' ' '\n' | sort | uniq -c | awk '{printf " %s x%s", $2, $1}')"
  echo "  passed $ok/$n, failed $bad/$n, exit codes:${codes:- none}"
}
page="curl -sf -H 'cookie: codeden_token_$P=$TOKEN' http://127.0.0.1:$P/"
slow="curl -sf -H 'cookie: codeden_token_$P=$TOKEN' 'http://127.0.0.1:$P/?slow'"
tpl="curl -sf -H 'authorization: Bearer $TOKEN' http://127.0.0.1:$P/api/automations/templates"
pretty="curl -sf -H 'authorization: Bearer $TOKEN' 'http://127.0.0.1:$P/api/automations/templates?pretty'"
echo "A. ci.yml:125 as written, page sent in one piece:  curl -sf ... / | grep -q '<title>CodeDen'  ($((runs * 10)) runs)"
count $((runs * 10)) "$page | grep -q '<title>CodeDen'"
echo "B. ci.yml:125 as written, page with a slow chunk:  curl -sf ... / | grep -q '<title>CodeDen'"
count "$runs" "$slow | grep -q '<title>CodeDen'"
echo "C. ci.yml:126 as written, single-line JSON:        curl -sf ... /api/automations/templates | grep -q security-audit"
count "$runs" "$tpl | grep -q security-audit"
echo "D. ci.yml:126 as written, JSON with line breaks:   ... | grep -q security-audit"
count "$runs" "$pretty | grep -q security-audit"
echo "E. The fix: each response to a file, then grep the file (B, A, C, D)"
count "$runs" "cd \"\$(mktemp -d)\"; $slow > index.html; grep -q '<title>CodeDen' index.html"
count $((runs * 10)) "cd \"\$(mktemp -d)\"; $page > index.html; grep -q '<title>CodeDen' index.html"
count "$runs" "cd \"\$(mktemp -d)\"; $tpl > templates.json; grep -q security-audit templates.json"
count "$runs" "cd \"\$(mktemp -d)\"; $pretty > templates.json; grep -q security-audit templates.json"
echo "F. The fix still fails the step when the server doesn't answer (nothing on port 4792)"
count "$runs" "cd \"\$(mktemp -d)\"; curl -sf http://127.0.0.1:4792/ > index.html; grep -q '<title>CodeDen' index.html"
echo "G. Why: curl's own message for exit 23"
bash -eo pipefail -c "$slow -S | grep -q '<title>CodeDen'"; echo "  exit $?"
