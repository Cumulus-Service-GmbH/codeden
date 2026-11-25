#!/bin/sh
# TrioHarness Lean 2.35 — run BEFORE the deploy step of a deploy workflow (checkout with fetch-depth: 0).
# Stops the deploy unless the commit that is running NOW is part of the commit being deployed, so a deploy can never
# silently replace code that exists only in what runs (an unmerged branch put there by hand, a hotfix).
#   HEALTH_URL        required  the app's public health/version endpoint
#   SHA_FIELD         default "sha"  JSON field holding the commit (last segment of a dotted path); "." = plain-text body
#   TARGET_SHA        default $GITHUB_SHA
#   ALLOW_UNREADABLE  set to the exact HEALTH_URL by a PERSON, for the first deploy of a build that starts reporting its commit
# Exit 0 = safe to deploy · 1 = stop.
set -eu
: "${HEALTH_URL:?HEALTH_URL is required}"
field="${SHA_FIELD:-sha}"
target="${TARGET_SHA:-${GITHUB_SHA:-}}"
if [ -z "$target" ]; then echo "::error::no commit to deploy (TARGET_SHA or GITHUB_SHA)"; exit 1; fi
body=$(curl -fsS --max-time 20 "$HEALTH_URL" 2>/dev/null || true)
if [ "$field" = "." ]; then
  running=$(printf '%s\n' "$body" | head -1 | tr -d '[:space:]' | grep -oE '^[0-9a-fA-F]{7,40}$' || true)
else
  key=${field##*.}
  running=$(printf '%s' "$body" | grep -oE "\"$key\"[[:space:]]*:[[:space:]]*\"[0-9a-fA-F]{7,40}\"" | head -1 | grep -oE '[0-9a-fA-F]{7,40}' || true)
fi
if [ -z "$running" ]; then
  if [ "${ALLOW_UNREADABLE:-}" = "$HEALTH_URL" ]; then echo "::warning::running commit unreadable; a person allowed this deploy"; exit 0; fi
  echo "::error::cannot read the running commit from $HEALTH_URL, so it cannot be compared with $target. Nothing was deployed. A person may re-run with ALLOW_UNREADABLE set to the health URL."
  exit 1
fi
full=$(git rev-parse --verify --quiet "$running^{commit}" 2>/dev/null || true)
if [ -z "$full" ]; then git fetch --quiet origin "$running" 2>/dev/null || true; full=$(git rev-parse --verify --quiet "$running^{commit}" 2>/dev/null || true); fi
if [ -z "$full" ]; then echo "::error::the running commit $running is in no branch of this repository (deleted branch, other repository, dirty build). Nothing was deployed."; exit 1; fi
if git merge-base --is-ancestor "$full" "$target"; then echo "running $running is part of $target: safe to deploy"; exit 0; fi
echo "::error::$running (running now) is not an ancestor of $target. Deploying would replace code that exists only there. Merge or promote it first. Nothing was deployed."
exit 1
