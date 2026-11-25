# deploy.mjs X4: interface, draft 3 (CONFIRMED against WCM-INTERFACE.md "Answers to CodeDen")

Status: **confirmed for implementation (draft 3.2 = draft 3 plus sections 13 and 14, with final review fixes in sections 15 and 16).** This document is the agreed contract. Its source is the WebChatMobile PM’s interface, received 2026-11-22 (SHA-256 `5357683e…`). The "Answers to CodeDen" section of `WCM-INTERFACE.md` records its provenance. Section 11 lists what the tool enforces itself and what stays with the release cards. Section 12 lists the few assumptions that WCM should confirm. Implementation proceeds on them now.

Base: live `deploy.mjs` sha256 `287e7445…` (stage-only and switch-traffic from c60aedd1). Running-ref semantics are unchanged.

## 1. Commands

```
deploy.mjs --target <t> --action build            --sha <S40>                                   [--dry-run] [--authorize "<phrase>"]
deploy.mjs --target <t> --action stage            --revision-input <f.json> --authority-receipt <r> [--sha <S40>] [--dry-run] [--authorize ...]
deploy.mjs --target <t> --action renew-authority  --revision-input <f.json> --authority-receipt <r> [--sha <S40>] [--dry-run] [--authorize ...]
deploy.mjs --target <t> --action switch   --op <op> [--percent 100]                             [--dry-run] [--authorize ...]
deploy.mjs --target <t> --action withdraw --op <op>                                            [--dry-run] [--authorize ...]
deploy.mjs --target <t> --action cleanup  --op <op> --retire-revision <name>                    [--dry-run] [--authorize ...]
deploy.mjs --target <t> --action rollback --op <op> --to-revision <name>                        [--dry-run] [--authorize ...]
deploy.mjs --target <t> --status <op>                                                           (read-only)
deploy.mjs --target <t> --action recover  --op <op>                                            [--dry-run] [--authorize ...]
```

- Phrase for every action: `<app>:<action>:<op-id>:<P64>`. The dry run prints the canonical plan, `op-id`, `P64` and the phrase, and writes nothing. Without `--authorize`, a `with-authorization` target is refused. `agentAllowed: false` still needs a person at an interactive terminal, and `true` can apply other actions without a phrase. Every recover apply requires its phrase.
- `--sha`, when given, must equal the input's `sourceSha` byte for byte.
- `switch` accepts only `--percent 100` (the default).
- `build` (new; this is WCM answer C's "separately authorized build/preparation step") runs `az acr build` at the exact SHA and journals `step: built` with the run id, digest and tag. It never touches the app. Its journal entry is the trusted exact-SHA build receipt that a later stage may cite.

## 2. Compatibility with the existing flags (resolution 1)

- A target is **G7-opted-in** when its default-branch declaration has a `settings` block (section 4).
- On a target that is not opted in, every legacy flag (`--stage-only`, `--switch-traffic`, `--percent`, `--rollback`, the plain deploy and its cleanup, `--promote-from`) and every legacy phrase stays exactly as it is.
- On an opted-in target, legacy write paths are refused with `G7_USE_ACTION` before any Azure call: the plain deploy, `--stage-only`, `--switch-traffic`, `--rollback`. They would bypass the G7 gates. Legacy rollback and cleanup dry runs return `X4_HISTORY_PRESENT` once X4 history exists (§15.9). A worktree-config write returns `G7_USE_ACTION` if a default-branch alias declares G7 for the same app or the default-branch config fails to load. Bootstrap can proceed when the config is confirmed absent.
- `--action` and `--status` conflict with legacy mode flags. Flags `--op`, `--retire-revision`, `--to-revision`, `--revision-input` and `--authority-receipt` require `--action` or `--status`. These conflicts return `DEPLOY_MODE_CONFLICT`.

## 3. `--revision-input` schema 1

Exactly these fields, all required:

```json
{
  "schema": 1,
  "sourceSha": "<40 lowercase hex>",
  "image": { "digest": "sha256:<64 lowercase hex>" },
  "revisionSuffix": "r<S8>-g<N>",
  "env": [ { "name": "<declared name>", "value": "<string>" } ],
  "envRefs": [ { "name": "<declared name>", "appRef": "<existing app alias>" } ],
  "secretVolume": {
    "name": "migration-authority",
    "alias": "migration-authority-g<N>",
    "kvVersionedUri": "https://<vault>.vault.azure.net/secrets/<item>/<version>",
    "identity": "<managed identity ARM id>",
    "mountPath": "/app/migration-authority",
    "path": "applied-set.json"
  },
  "authorityReceiptSha256": "<64 lowercase hex>",
  "expiresAtUtc": "<YYYY-MM-DDTHH:MM:SS[.fff]Z>"
}
```

Validation (all refusals happen before any Azure call):
- Duplicate JSON keys are refused (a strict parser, before `JSON.parse`), as are invalid UTF-8 or a BOM, unknown keys at any level, missing fields, non-string env values, malformed hex or timestamps, and duplicate env names, including a name that appears in both `env` and `envRefs`.
- `N` = the value of the declared generation env (`MigrationAuthority__Generation`): a canonical positive decimal string (`^[1-9][0-9]*$`, ≤ 9223372036854775807), compared as BigInt. `revisionSuffix` must equal `r` + `sourceSha[0:8]` + `-g` + `N`, and `alias` must equal the declared alias prefix + `N`.
- Every `env` name and `envRefs` name must be declared (section 4), and each `env` value must pass its declared validator. A plain env name that looks secret (`/(secret|password|pwd|connection.?string|api.?key|token|credential)/i`) cannot be declared as plain.
- `kvVersionedUri` must be `https://<declared vault host>/secrets/<declared item>/<version>` with a version segment of 32 hex characters, and no query, fragment or userinfo. `identity` must equal the declared identity exactly. `name`, `mountPath` and `path` must equal the declared ones.
- Both WEB pins (every env declared with `format: "webPin"`) must equal the target's `build.buildArgs.WEB_BASE_SHA` on the default branch. The candidate's `/health` `webBaseSha` must also equal it (section 6), which proves the compiled image matches.
- `--authority-receipt <file>`: the SHA-256 of the file's bytes must equal `authorityReceiptSha256`. If the receipt is JSON with top-level `expiresAtUtc` or `generation`, those must equal the input's values. The tool never parses the manifest itself.
- `expiresAtUtc` must lie at least `settings.minExpiryHeadroomSeconds` (default 3600) in the future at dry run, at apply, and again immediately before a switch.
- `image.digest` is required. At stage, it must equal either the digest in a `step: built` journal entry of this target for `sourceSha`, or the digest in a verified entry of the declared `promoteFrom` target for that SHA (the existing promotion rule). Otherwise the stage is refused with `DIGEST_PROVENANCE_UNPROVEN`. At renew, it must equal both the image configured on the exact serving revision (read as metadata) and the digest in the serving revision's verified journal entry. Renew runs no build.

## 4. Default-branch declaration (`.trioharness/deploy.json`, per target)

`validateConfig` refuses keys that contain secret-like words, so the block uses `vault*`/`alias*` names:

```json
"settings": {
  "generationEnv": "MigrationAuthority__Generation",
  "revocationEnv": "MigrationAuthority__RevocationGeneration",
  "env": [
    { "name": "MigrationAuthority__ApprovedSha256", "format": "hex64" },
    { "name": "MigrationAuthority__Environment", "equals": "TEST" },
    { "name": "MigrationAuthority__DatabaseEnvironment", "equals": "QA" },
    { "name": "MigrationAuthority__TargetId", "format": "hex64" },
    { "name": "MigrationAuthority__Generation", "format": "generation" },
    { "name": "MigrationAuthority__RevocationGeneration", "format": "generation" },
    { "name": "MigrationAuthority__WebSourceSha", "format": "webPin" },
    { "name": "WEB_BASE_SHA", "format": "webPin" }
  ],
  "envRefs": [],
  "authorityVolume": {
    "name": "migration-authority", "aliasPrefix": "migration-authority-g",
    "vaultHost": "<vault>.vault.azure.net", "vaultItem": "<item>",
    "identity": "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.ManagedIdentity/userAssignedIdentities/<id>",
    "mountPath": "/app/migration-authority", "path": "applied-set.json"
  },
  "minExpiryHeadroomSeconds": 3600
},
"health": { "...existing...": "...", "expect": { "webBaseSha": "{webPin}", "<dotted path>": "<exact string>" } }
```

- The validators are `format: hex64 | hex40 | generation | webPin` and `equals: "<exact>"`, exactly one per entry. `envRefs` entries are `{ "name", "aliasPattern" }`.
- `health.expect` maps dotted JSON paths of the health body to exact strings (`{webPin}` is substituted). For G7, WCM fills in the paths for `db=ok`, `migrationCheck.state=ok` and `migrationCheck.reason=verified-applied-set` (section 12).

## 5. Canonical form, op id and P64 (resolution 2)

- Canonical JSON = RFC 8785 JCS over validated data: objects with keys sorted by UTF-16 code units, strings as JSON.stringify writes them, integers only, `null`, booleans, and no whitespace. Before canonicalization, arrays are sorted: `env`/`envRefs` by `name`; traffic by `revisionName` then `label`; revision-name lists by name; volumes by name and their mappings by `path` then the alias. `inputSha256` = the lowercase SHA-256 of the canonical normalized input.
- Envelope = `{schema: 1, action, opId, target, expected, args}`.
  - `target` = `{name, resourceId, containerName, policySha256}`. `resourceId` = `/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.App/containerApps/<app>`. `containerName` = the declared container or `null`. `policySha256` = the SHA-256 of the canonical default-branch target declaration.
  - `expected` = `{servingRevision, servingSha, traffic, activeRevisions, testFenceReceiptSha256}`. Traffic entries are exactly `{revisionName, label, latestRevision, weight}` (an absent label → `null`, latest → `false`, weight → `0`). `activeRevisions` = the sorted names of the active revisions. `testFenceReceiptSha256` is always `null`. Build binds the normalized traffic map as read, including an empty or unpinned map, and records serving metadata when available. A failed-switch rollback may also bind a split map with null serving fields.
  - `args` per action:

  | Action | `args` |
  |---|---|
  | build | `{sha, imageTag}` |
  | stage, renew-authority | `{input, imageRef, candidateRevision, intermediateRevision, volumePatchSha256}` (the full normalized input; `intermediateRevision` and `volumePatchSha256` are `null` only when the volume already maps to the alias) |
  | switch | `{stagePlanSha256, candidateRevision, candidateSha, imageDigest, percent, resultingTraffic}` |
  | cleanup | `{stagePlanSha256, retireRevision, protectedRevisions}` |
  | withdraw | `{stagePlanSha256, stagePolicySha256, retireRevision, protectedRevisions}` |
  | rollback | `{stagePlanSha256, stagePolicySha256, fromRevision, restoreRevision, restoreSha, resultingTraffic}` |
  | recover | `{priorPlanSha256, recoveryStep, revisions, resultingTraffic}` (`resultingTraffic` is `null` when the step moves no traffic). Also binds `state`, `observedSha256`, and `stagePolicySha256` for rollback or withdraw recovery. |

- For build, stage and renew: `op-id` = `op-` + the first 12 hex characters of the SHA-256 of the canonical envelope with `opId` omitted. P64 = the SHA-256 of the canonical envelope including that `opId`. Later actions reuse the stage's op id. On lookup the full P64 is compared, and an op id whose journal entries carry a different `planSha256` for the stage is refused (`OP_ID_COLLISION`).
- Any drift between the dry run and the apply (traffic, active revisions, serving SHA, input, policy) changes P64, so the phrase is refused with `AUTHORIZATION_REQUIRED` and the new phrase is printed.

## 6. Stage and renew (V1-b, resolution 5)

Writes on one app are serialized by an exclusive lock file `x4.lock` (created with `wx`) in the app's history directory. If a lock exists, the run is refused with `APP_WRITE_LOCKED` and the lock is never broken automatically.

Read-only preflight (fail closed, nothing written):
1. The existing checks: Multiple revisions mode, one container (matching `container`), traffic pinned to one named revision at 100%, no `latestRevision` routing. Labels on any traffic entry are refused with `TRAFFIC_LABELS_PRESENT`.
2. The live expected state equals the envelope's `expected`.
3. **First mount:** the app template's container has a `volumeMounts` entry `{volumeName: <declared name>, mountPath: <declared mountPath>}`. Otherwise the run is refused with `VOLUME_MOUNT_NOT_PROVISIONED`, and mount provisioning stays a separate, reviewed step outside V1-b.
4. **Alias:** the app's vault references (metadata `{name, keyVaultUrl, identity}`) include `alias` with `keyVaultUrl` **exactly** equal to `kvVersionedUri` and `identity` exactly equal to the input's. Otherwise the run is refused with `ALIAS_NOT_PROVISIONED`. The tool never creates aliases. The list of existing vault references is kept as `before`.
5. Renew only: the input generation is greater than the generation journaled for the serving revision's op. `RevocationGeneration` equals `Generation`, so no WEB interlock is open (otherwise `WEB_INTERLOCK_OPEN`). Renew reuses the serving revision's exact image reference. It must match the declared target or promotion source registry and repository at `image.digest` and the verified journal entry for that revision.
6. Neither the intermediate nor the candidate revision name exists yet (`REVISION_EXISTS`).

Writes (each one preceded by an `intent` journal entry and followed by a result entry):
1. **Volume PATCH** (skipped when the template volume already maps the declared name to `alias` at `path`): `az rest --method PATCH --url https://management.azure.com<resourceId>?api-version=2025-07-01 --body @<file>`, with body `{"properties":{"template":{"revisionSuffix":"<candidate suffix>-v","volumes":[<every existing volume unchanged, with the declared volume replaced by {name, storageType:"Secret", secrets:[{secretRef: alias, path}]}>]}}}`. The existing volumes are read with `az containerapp show --query properties.template.volumes` (names and alias refs only). Then poll until the intermediate exists at 0% with no label, is `latestRevisionName`, has the expected volumes and reports `Provisioned` or `Failed`. Traffic must stay unchanged. Journal `step: intermediate`.
2. **Image and env:** `az containerapp update --image <loginServer>/<image>@<digest> --revision-suffix <revisionSuffix> --set-env-vars <name>=<value>… <name>=secretref:<appRef>… [--container-name <c>] --only-show-errors`. The environment values come only from the validated input. When the digest comes from `promoteFrom`, the update uses the exact verified source image reference, and P64 binds that reference. `--replace-env-vars`, `--remove-env-vars`, `--remove-all-env-vars`, `--yaml` and `--secret-volume-mount` are never used. Journal `step: revision-created`.
3. Traffic is unchanged before and after the health check (`verifyStage` uses `trafficEquals`).
4. **Metadata compare on the candidate** (names and refs only): the revision must reach `Provisioned` before it is accepted; the image is exactly the pinned ref; env names ⊇ the names in the `before` template plus the declared ones; each `envRefs` secretRef equals its `appRef`; each `before` secretRef is unchanged; the volumes equal the intermediate's volumes (the declared one maps to `alias` at `path`); the mount is present; the app's vault references still include every `before` entry unchanged and the alias still matches. A mismatch is refused with `REVISION_SETTINGS_MISMATCH` (names only in the message).
5. **Health** at the candidate's FQDN at 0%: HTTP 200, the full `sourceSha` equal to the input's, and every `health.expect` path equal. Journal `step: verified` with `staged: true`.
6. **Deactivate the intermediate** only now, after checking that it is still at 0% with no label: `az containerapp revision deactivate`. Journal `step: deactivated`. A failure leaves the op at state `intermediate-left` (section 9).

The intermediate runs the old image and env with the new volume. Both terminal provisioning states establish that Azure applied the template. The intermediate carries no traffic. Status and deactivation use the intermediate's settings and traffic metadata regardless of its provisioning state.

## 7. Switch, withdraw, cleanup, rollback (resolutions 6 and 7)

- **switch:** the op's stage is `verified`. The candidate still has its exact image and settings (the section 6 step 4 checks repeated), still reports healthy at 0%, the expiry headroom still holds, and traffic still equals `expected`. The candidate generation must exceed the journaled generation of any serving X4 candidate (`GENERATION_NOT_NEWER`). Then `ingress traffic set <candidate>=100`. Verify: the traffic metadata matches the planned result, the candidate's image is the digest, and the live health passes. Journal `{step: 'intent', write: 'traffic'}` → `switched`. On a verify failure, stop and report the expected and observed state. Traffic is never restored automatically; an explicit `rollback` with its own phrase does that.
- **withdraw:** deactivates the op's active candidate and intermediate if each is owned by a matching journaled write intent, has weight 0, and has no label. Stage verification is optional for withdrawal.
- **cleanup:** deactivates exactly `--retire-revision`, only if it has weight 0 and no label, is not the serving revision, and is not the op's candidate. `protectedRevisions` = the serving revision plus the candidate. A verified switch whose cleanup failed stays `switched`.
- **rollback:** `--to-revision` names the destination explicitly, never selected by SHA or by `previousRevision`. The destination is active, and at its FQDN it reports HTTP 200 and a full 40-hex SHA (`restoreSha`, bound in P64). If `health.rollbackExpect` is declared, those paths must match too (WEB compatibility). Then `ingress traffic set <restore>=100`, verified by the traffic metadata and the live health equal to `restoreSha`.

After a traffic write, the destination must be the only positive-weight entry at 100%. Labels and latest-revision routing are refused. A zero-weight entry may name only the destination or a revision in the pre-write map.

Rollback, withdraw, and recovery of those actions accept a changed declaration only when the resource ID and container name match the journaled stage. Their P64 binds the current policy hash in `target` and the stage policy hash in `args`. Switch and cleanup require the stage policy to match the current policy. With X4 app history and the same normalized target identity, removing `settings` still allows status, rollback, withdraw, and recovery of rollback or withdraw. Other X4 actions return `G7_NOT_DECLARED`.

## 8. Initial TEST cut-over

The initial cut-over requires an ordinary serving baseline with ingress enabled, health available, and 100% of traffic pinned to one named revision. With an empty traffic map, Azure can route to the latest revision. Disabling ingress prevents health checks at the revision FQDN. The removed `--test-fence-receipt` flag returns `TEST_FENCE_UNSUPPORTED` before any reads.

## 9. Status and recover (resolution 7)

`--status <op>` is read-only: it reads the op's journal, the revision list and show (narrow queries) and the traffic, then prints `{state, observed, templateNotServing, nextStep, expected, plan, phrase}` plus recovery metadata when applicable. A declaration edit sets `policyChanged: true` and status still reconciles the live state.

| State | Detected by | `recover` step |
|---|---|---|
| `intermediate-only` | `intermediate` journaled; candidate absent; intermediate exact, at 0%, no label, and still `latestRevisionName`; traffic = `expected.traffic` | `finish-stage`: steps 2-6 of section 6 |
| `staged-unverified` | `revision-created` journaled; candidate exact (metadata) at 0%; traffic = `expected.traffic` | `reverify-stage`: steps 3-6, no new revision |
| `intermediate-left` | stage `verified`; the journal-owned intermediate is active, at 0%, no label | `deactivate-intermediate` |
| `switch-applied-unrecorded` | Switch traffic intent without `switched`; traffic matches the planned candidate result (§7); candidate healthy | `record-switch` (no write) |
| `switch-not-applied` | Switch traffic intent without `switched`; traffic = the pre-switch snapshot | none: run `--action switch` again (new dry run, new card) |
| `deactivate-pending` | withdraw or cleanup intent; the named revision is still active at 0% | `retry-deactivate` (that exact name only) |
| `deactivate-done-unrecorded` | withdraw or cleanup intent; the named revision is inactive | `record-deactivated` (no write) |
| `rollback-applied-unrecorded` | rollback intent; traffic matches the planned restore result (§7); restore healthy | `record-rollback` (no write) |
| `rollback-not-applied` | Rollback traffic intent without `rolled-back`; traffic still matches the pre-rollback snapshot. A null bound serving SHA allows unreadable or newly readable serving health. | none; run `--action rollback` again with a new dry run and card |
| `drift` | traffic differs from both the before and the planned after snapshot, labels appear, ownership is unclear, or anything is unreadable | none: STOP and report `expected` vs `observed`; any traffic write needs a new corrective card |
| `staged` · `switched` · `withdrawn` · `cleaned` · `rolled-back` · `failed-before-write` · `built` · `failed` · `recovered` | Recorded outcome | none |
| `intent` · `verified` · `deactivated` | Journal step without a more specific reconciliation result. Status can refine deactivation or recovery with the journaled action and outcome. | none |

Before `finish-stage` can run, the intermediate must report `Provisioned` or `Failed`. Recovery otherwise returns `INTERMEDIATE_NOT_READY`.

A revision is attributed to an op only by its exact journaled name and its exact metadata. Recency, a mismatched image or an equal source SHA are never enough. `recover` re-reads everything under the app lock, recomputes the state, and refuses unless that state, its step and the P64 equal what status printed.

## 10. Journal (the history.d ledger)

Append-only `history.d/<NNNNNN>.json`, one exclusive create per entry, as today. New fields: `op`, `action`, `step` (`intent`, `built`, `intermediate`, `revision-created`, `verified`, `deactivated`, `switched`, `rolled-back`, `withdrawn`, `cleaned`, `recovered`, `failed`), `write` (the write id on `step: 'intent'`, see §13.9), `planSha256` (= P64), `inputSha256`, `expected`, `observed` (the traffic, active flags and metadata names and refs after the step), `settings` (`{env: [names], envRefs: [{name, appRef}], volume: {name, alias, kvVersionedUri, identity, mountPath, path}}`, never values), `generation`, `expiresAtUtc`, `authorityReceiptSha256`, `failure` (a fixed code). The plain env **values** are not journaled: `inputSha256` binds them, and the owner keeps the input file. The existing fields keep their meaning, and legacy readers skip entries that have `op`.

## 11. What the tool enforces vs the cards

The tool enforces everything in sections 2-10 from the default-branch declaration, the input, the receipts' hashes and az metadata. The release cards and the owner remain responsible for: the truth of the authority receipt; "TEST never falls back to a PRD-bound revision" (the tool cannot read env values to tell); the correctness of `TargetId`; and the PROD break-glass choice of `mobile-api-prod--rdee469c2`. The tool checks a rollback destination's health and binds its name, but does not decide that policy.

## 12. Assumptions for WCM to confirm (implementation goes ahead on them)

1. `health.expect` paths for `db` and `migrationCheck` are declared by WCM in deploy.json. The tool hard-codes no G7 path.
2. Renew enforces "no open WEB interlock" as `RevocationGeneration == Generation` in the input.
3. The authority receipt is checked by file hash, plus `expiresAtUtc`/`generation` when present at the top level of a JSON receipt.
4. The intermediate suffix is `<revisionSuffix>-v`, and the ARM api-version is pinned to `2025-07-01`.
5. `build` is a new action, the authorized preparation step that WCM answer C asks for.

## 13. Draft 3.1: plan-review fixes (codex / gpt-6.2-astra / high, BLOCK, dispositioned once)

13.1 **PATCH completion (R01).** The ARM PATCH uses `api-version=2025-07-01` (see §16). The first mount must exist before any write. After the PATCH, a bounded poll waits until the named intermediate exists with `provisioningState` equal to `Provisioned` or `Failed`, is `latestRevisionName`, has exactly the expected volumes, and traffic is unchanged. Either terminal state allows the candidate update to run. A candidate reporting `Failed` returns `REVISION_PROVISIONING_FAILED`. If the latest revision is not the intermediate, the run is refused with `TEMPLATE_RACE`.
13.2 **Data flow of the flag-path update (R02).** Inside the az process, `az containerapp update --image … --set-env-vars …` reads the app template and resends the existing plain env values and secretRef names, the same as the live deploy path today. It does not call listSecrets, so no secret value is read. deploy.mjs runs both X4 writes with `-o none` and never captures a response body. No value reaches the journal, stdout or an error message.
13.3 **Body schema (R03).** The body is `{"properties":{"template":{"revisionSuffix","volumes":[…]}}}`. Each volume allows only `name`, `storageType`, `storageName`, `mountOptions` and `secrets[{secretRef, path}]`. There are no `configuration`, `containers` or `env` keys. The body file is created exclusively in a private temp directory, and the boundary test validates the builder's real output.
13.4 **Default branch and name safety (R04).** X4 actions refuse `--config-from-worktree` (`X4_DEFAULT_BRANCH_ONLY`). Plain values containing `secretref:` (any case) are refused. A name that equals an existing env name except for case is refused (`ENV_NAME_CASE_COLLISION`).
13.5 **Recovery reverification (R05).** The intent entry for the update persists `before` (env names and secretRefs, vault references, volumes). `reverify-stage` and `finish-stage` repeat every §6 step 4 check before `verified`.
13.6 **Ordered reconcile (R06, R07).** `--status` reads the journal for the op and takes the newest entry `E`, then re-reads the metadata and the full traffic map. The first matching rule wins:
  1. The metadata or traffic is unreadable, there are labels, or traffic matches neither the op's `expected.traffic` nor its planned result under §7 → `drift` (STOP).
  2. `E.step == failed` and no write was journaled after the last verified step → `failed-before-write` (terminal).
  3. `E` is a stage or renew `intent` for `volume-patch`: if the intermediate is absent, latest is unchanged, and `azReturned: false` → `failed-before-write`; if it is present, exact, at 0% and latest → `intermediate-only` (`finish-stage`); otherwise → `drift`.
  4. `E` is `intermediate`, or an `intent` for `update`: if the candidate is absent and the intermediate is exact and latest → `intermediate-only`; if the candidate is present → `staged-unverified` (`reverify-stage`, full checks); if there was no PATCH, the candidate is absent, latest is unchanged, and `azReturned: false` → `failed-before-write`; otherwise → `drift`.
  5. `E` is `revision-created` → `staged-unverified`.
  6. `E` is `verified` (stage), or an `intent` for `deactivate` of the intermediate: if the intermediate is active → `intermediate-left` (`deactivate-intermediate`); otherwise → `staged`.
  7. `E` is a switch traffic intent: traffic matches the planned result and the candidate is healthy → `switch-applied-unrecorded`; traffic equals `expected.traffic` → `switch-not-applied`; otherwise → `drift`.
  8. `E` is a rollback traffic intent: the same three outcomes as rule 7, against the restore map.
  9. `E` is a withdraw or cleanup intent: the named revision is active at 0% with no label → `deactivate-pending`; it is inactive → `deactivate-done-unrecorded`; otherwise → `drift`.
  10. Otherwise → the terminal state named by `E`.

  Recover re-runs the same decision under the app lock and requires the same state, step and P64 as the status output.
13.7 **Switch and rollback success (R08).** These are their own code paths. Success is appended only after the complete traffic map equals the planned map exactly, the destination's image matches, and the health check passes.
13.8 **Authorization (R09).** The digest comes from the input, so P64 is known at dry run. The op id is derived from the envelope. `expected.traffic` binds the full map for every action. X4 requires the phrase on every target except `agentAllowed: true`, at a TTY too, and `agentAllowed: false` additionally requires a TTY.
13.9 **Intent before write (R10).** Each az write has its own `write` id (`acr-build`, `volume-patch`, `update`, `traffic`, `deactivate`) in an intent entry created before the call. If the journal create fails, no az call is made.
13.10 **Legacy isolation (R11).** Entries with an `op` field are filtered out before `recentHistory` and every legacy selection. X4 actions need an opted-in target (`G7_NOT_DECLARED`).

## 14. Draft 3.2: Architect answers to the Writer's contract questions

14.1 **Stage intent and recovery input.** Intent entries persist redacted args: `input.env` as `[{name, valueSha256}]`, `envRefs` in full (names and alias refs only), the volume metadata, and `planSha256` plus `inputSha256`. `finish-stage` needs the plain values, so its apply requires `--revision-input` and `--authority-receipt`. Their `inputSha256` and receipt hash must equal the stored ones (`RECOVER_INPUT_MISMATCH`). `reverify-stage`, `deactivate-intermediate`, the `record-*` steps and `retry-deactivate` need no input file. `--status` and `recover --dry-run` never require it: when the step is `finish-stage`, status prints `needsInput: true`.
14.2 **Recover approval.** The recover `args` add `state` and `observedSha256` (the SHA-256 of the canonical observed snapshot that reconcile used), so a changed observation changes P64. `recover` requires `--authorize` with its phrase on **every** target policy, `agentAllowed: true` included, because recovery is exceptional. `false` additionally requires a TTY.
14.3 **Build receipt.** The `acr-build` write is the one write whose stdout is captured, and only to hand the run record to `acrRunDigest` in memory. The run record is never printed or journaled. Parse failures become fixed codes (`ACR_RUN_UNREADABLE`). X4 `build` refuses targets with `build.buildArgsFromApp` (`X4_BUILD_ARGS_FROM_APP_UNSUPPORTED`), so no app-derived value is ever passed to or returned from the build.
14.4 **Failed writes in reconcile.** A newest entry `{step: 'failed', write}` is evaluated as its matching `intent` (same op, same write), so the live state decides through rules 3-9. Rule 2 (`failed-before-write`) applies only when that evaluation finds the write had no effect (for example, the intermediate is absent after a failed volume PATCH). A failed intermediate deactivation gives `intermediate-left`. A failed cleanup is judged by its own cleanup plan (rule 9), and the op's earlier switch result is never changed by it.
14.5 **Recover intents.** A recover intent carries `priorPlanSha256`, `recoveryStep` and `write`. Reconcile follows `priorPlanSha256` to the original action's plan, then classifies the entry as that action's intent for the same write: `finish-stage` update → rule 4, `deactivate-intermediate` → rule 6, `retry-deactivate` → rule 9. A failed recover write follows 14.4.
14.6 **Dry-run display.** The printed plan uses the 14.1 redacted projection plus `inputSha256`. P64 is computed from the full in-memory envelope, so the displayed plan may differ from the hashed bytes. The owner verifies the input file through `inputSha256`.

## 15. Final review fixes

1. Owner-only targets refuse detected agents even with the phrase and require a TTY plus interactive confirmation.
2. Rollback can use the preceding serving revision from the newest switch intent or failed traffic write only while the candidate has positive live traffic weight and every other weighted entry names the switch plan's preceding serving revision. Otherwise it returns `ROLLBACK_OP_NOT_SERVING`. A valid split binds the complete map in P64 with null serving revision and SHA fields.
3. Rollback binds a null serving SHA when the live endpoint is unreadable. Destination FQDN health remains mandatory.
4. Promotion requires a verified legacy serving entry or a switched X4 entry for the digest, the source's live SHA, and the source's exact pinned revision image.
5. The CLI validates each Azure argv against the reviewed queries and exact operation builders. The literal boundary scan also covers the PATCH resource ID.
6. A missing PATCH intermediate with unchanged latest is drift unless the journal records a failed PATCH call with `azReturned: false`.
7. Switch and rollback recheck app shape before writing traffic.
8. Azure reads capture stderr and report `AZ_READ_FAILED` without command output.
9. Any X4 entry in the app history blocks legacy rollback and cleanup with `X4_HISTORY_PRESENT`.
10. Renew uses the required `revocationEnv`, declared as a distinct `generation` env, for the generation interlock. G7 declares `MigrationAuthority__RevocationGeneration`.
11. Initial cut-over requires a serving baseline (§8).
12. Writes require Azure CLI ≥ 2.91.0 and < 3.0.0, plus Container Apps extension 1.3.0b6.
13. Journal entries bind canonical redacted args with `redactedArgsSha256`. Later stage-plan loads reject a missing or mismatched hash with `JOURNAL_TAMPERED`.

## 16. Round 3 review decisions

- The deploy scripts and `history.d` share the same local filesystem trust boundary as legacy history. The X4 journal hash detects accidental corruption only.
- `appHistoryKey` trims and lowercases the app type, subscription, resource group, app and slot. Container names are excluded from the key.
- Worktree-config dry runs keep their existing behavior because they make no writes.
- X4 authorization uses the strictest policy across default-branch declarations matching `sameContainerApp`, which compares normalized container app type, resource group and app name, ignores slot and deliberately ignores subscription to fail closed, and distinguishes WebChatMobile TEST and PROD by their different app names. Owner-only (including omitted `agentAllowed`) takes precedence over `with-authorization`, then `true`. Agent detection uses the union of the declared markers and the default markers.
- Legacy rollback and cleanup load the invoked target's own history first. An unreadable entry there returns `HISTORY_ENTRY_UNREADABLE` and names the file. The subsequent X4 history scan (`findRecordedX4History`) matches identified Container App stores by resource group and app name across subscriptions and slots. A matching store blocks the operation if its history is unreadable or contains an `op` entry. For a store with unknown identity, both the directory slug must match the app slug and the history must be unreadable or contain an `op` entry. The unknown-identity check deliberately ignores app type and resource group to fail closed. An unreadable unidentified store for a same-named app can therefore block legacy rollback until a person fixes or removes the store. The scan's refusal names the directory as `X4_HISTORY_PRESENT: <dir>`.
- X4 status, rollback, withdraw and recovery of rollback or withdraw require the journaled resource ID to match case-insensitively and the container name to match after trimming and lowercasing. If `settings` was removed and the declaration was respelled so it points to a different history store, these X4 actions return `STAGE_POLICY_CHANGED` and legacy rollback and cleanup return `X4_HISTORY_PRESENT`. The person restores the original declaration spelling on the default branch to run X4 rollback or withdraw.
- Legacy reads use `sh` with inherited stderr. X4 Azure reads and writes pipe stderr and return fixed failure codes. `sh` forwards the provided stdio options to `execFileSync` and lets its raw errors reach `shQuiet`, which checks `status`, `signal` and `code` before returning a fixed refusal.
- A rollback based on `switched` or `record-switch` requires the operation's candidate to match its planned traffic result under §7. A mismatch returns `ROLLBACK_OP_NOT_SERVING`. The failed-switch rule in §15.2 still applies.
- The intermediate mounts the new authority file while running with the old `ApprovedSha256`. The G7 reader's digest check fails closed with HTTP 503 (`unknown`), so the intermediate never admits.
- After a switch or rollback traffic write, live and destination health must report the expected SHA within the configured health timeout. Retries are 10 seconds apart.
- Runtime argv validation precedes the write intent. A failed CLI invocation records `azReturned: false` only for a confirmed failure to start and `azReturned: null` for an unknown outcome. An absent intermediate after an unknown outcome is `drift`.
- The revision input includes a validated plain value for every name in `settings.env`. Missing names return `INPUT_INCOMPLETE`. As on the live deploy path, plain values appear in the Azure CLI process arguments and can be seen locally. This is accepted because the declaration refuses secret-looking plain names and uses plain bindings for non-secret values such as hashes, generations, and environment labels.
- In the reviewed Container Apps extension 1.3.0b6, `ContainerAppUpdateDecorator.construct_payload` routes YAML separately at `azext_containerapp/containerapp_decorator.py:185`. The registry branch calls `set_up_get_existing_secrets` at line 395, and the YAML path calls `list_secrets(show_values=True)` at line 544. The X4 image and env update supplies flags for neither branch.
- X4 Azure reads time out after 120 seconds. App writes use `Math.max(600, health.timeoutSeconds) * 1000` milliseconds, and ACR builds use `Math.max(1800, health.timeoutSeconds) * 1000` milliseconds. The intermediate and candidate provisioning polls also use the 600-second floor. Omitted health timeouts default to 300 seconds. SIGINT and SIGTERM remove the PATCH body directory, release the app lock only when its recorded PID is still this process's PID, and exit with codes 130 and 143 respectively.
- The ARM volume PATCH targets the core module's API version `2025-07-01` (`azure/cli/command_modules/containerapp/_clients.py:19`). The Container Apps extension 1.3.0b6 update path uses `PREVIEW_API_VERSION = "2025-10-02-preview"` (`~/.azure/cliextensions/containerapp/azext_containerapp/_clients.py:32`). Both writes use JSON merge patches against the same Container App resource. The volume PATCH replaces the entire `template.volumes` array and sets `template.revisionSuffix`. Omitted fields such as `template.containers` and configuration stay in place. A null member in a patch object means deletion. [Container Apps Update](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/update?view=rest-resource-manager-containerapps-2025-07-01), [RFC 7396](https://www.rfc-editor.org/rfc/rfc7396).
- After withdraw or rollback, the app template retains the last created revision's settings. Each later X4 stage reapplies the full declared settings. Status reports `templateNotServing: true` when traffic goes to named revisions and the latest revision receives none.
