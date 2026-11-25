# Promotion Rehearsal

Use this gate for container, VM, or cloud promotion. Run it before requesting the final mutation authorization. Rehearse the exact reviewed SHA on the target operating system and runtime, without touching the live workload.

## Required proof

1. Materialize the frozen SHA from `git archive` or a clean clone into a new staging directory. Exclude the working tree's `node_modules`, caches, generated secrets, ignored files, and untracked files. Record the artifact SHA-256.
2. Run every deployment generator, preflight, build, migration check, and verifier through the same interpreter/container entrypoint that production will use. A helper may not rely on a host package, cache, SDK, shell profile, or untracked file. For a network-disabled helper, smoke-test it while the network is actually disabled.
3. Inspect Git modes for every directly invoked script. Either commit the required executable bit or invoke the interpreter explicitly at every call site, including nested wrapper calls. Test the packaged artifact, not only the working tree.
4. On cross-platform workflows, detect CRLF/LF behavior in templates and generated runtime files. Normalize only generated configuration when required; never rewrite the reviewed source during promotion. Assert the generated parser input contains no stray carriage returns.
5. Exercise preflight while the current exact project/network/port already exists. It must distinguish its own resources from foreign resources. If safe rehearsal proves the project must stop first, declare the maintenance window and prove the rollback route before authorization; do not bypass the check.
6. For JSON cloud/API mutations from Windows, use a validated file-backed payload or a native SDK. Do not depend on shell-escaped inline JSON. Dry-run and reread the complete post-state.
7. After process/container start, use a bounded readiness loop with timeout and diagnostic capture before health or protocol probes. An immediate connection reset is not evidence of application failure.
8. Validate privileged-command transport without displaying or placing credentials in arguments. Account for remote `use_pty`, CRLF added by Windows native pipelines, and exact non-interactive sudo scope.
9. Prove rollback restores the previous image/source/configuration and preserves required data volumes. Keep its exact targets resolved and scoped.

## Receipt

Write `PROMOTION_REHEARSAL.json` under the run root:

```json
{
  "schema": 1,
  "frozenSourceSha": "40-character-reviewed-sha",
  "gates": {
    "cleanSource": { "status": "passed", "evidence": ["artifact sha256 ..."] },
    "entrypoints": { "status": "passed", "evidence": ["packaged helper smoke test ..."] },
    "lineEndings": { "status": "passed", "evidence": ["generated runtime parser check ..."] },
    "livePreflight": { "status": "passed", "evidence": ["existing-project rehearsal ..."] },
    "readiness": { "status": "passed", "evidence": ["bounded readiness result ..."] },
    "cloudPayloads": { "status": "not_applicable", "reason": "No cloud/API mutation." },
    "rollback": { "status": "passed", "evidence": ["previous image/config/data restoration proof ..."] }
  }
}
```

For a genuinely irrelevant gate, use `not_applicable` with a concrete reason. Rollback is never optional. Evidence must name an artifact, command result, or target-state observation, not an intention.
