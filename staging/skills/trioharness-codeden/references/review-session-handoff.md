# Direct review-session handoff

Installed version: `1.1.0+codex.20260912125840`.
Source: `<HOME>/plugins/trioharness-direct`.
Private remote: `Cumulus-Service-GmbH/trioharness-direct`, branch `main`.
B4a: `cdd009a`. Separate INTERIM documentation commit: `b3d1619`.

Reload Direct to receive both the B4a launcher and the INTERIM cross-repo guidance in SKILL.md. The block wording now states that each lane has one repository root and cross-repo execution within one lane is unsupported; it points to these two patterns rather than claiming instructions are missing:

- **Pattern 1 — read-only second repo, preferred:** the coordinator reads repo B and embeds the necessary contents, signatures, and constraints in repo A's packet. The writer operates only in repo A.
- **Pattern 2 — writes in both repos:** run sequential single-root lanes. Lane A supplies a self-contained SYNC CONTRACT naming B's paths, signatures, expected behavior, and acceptance criteria. The coordinator reviews it and embeds it in lane B's packet, independently scopes both lanes, records the pair and outstanding work, handles partial failure, and verifies final agreement. There is no cross-lane transaction.

This is the approved path until B4b is decided; consistency between lanes is the coordinator's judgment, not an enforced invariant. The section remains INTERIM.

Forbidden: using a parent `--repo` to encompass both repos, letting a lane edit outside its own root, or bypassing scope, marker, hash, review, or promotion checks. No multi-root authoring capability was added.

`DIRECT_OUT_OF_ROOT_GUARD=1` is available for deliberate per-lane use and remains default-off. It snapshots discovered sibling Git repos, registered worktrees, and explicitly declared roots before launch, then checks net tracked/index/untracked-content and HEAD changes at terminal handling. An external-root change fails the lane as `out-of-root-modification`, with roots/paths in monitor and telemetry. Failed observation is a distinct failure and an incomplete start baseline blocks model launch. Existing unchanged dirty state is allowed.

Approved Pattern 2 policy: the coordinator must set `DIRECT_OUT_OF_ROOT_GUARD=1` in each of the two lane invocation environments, including dry-run, and confirm both repos are in the discovered set. Do not set a global default or enable unrelated/Pattern 1 lanes. This is coordinator-applied invocation policy; the launcher has no Pattern 2 packet field. It detects unauthorized spillover, not sync correctness.

Concurrent activity in a sibling root (another Codex session, build watcher, or open editor) can cause false positives. Two sessions edited this tree concurrently during this review. The guard observes HEAD movement and untracked content, not only lane writes; coordinate quiet roots and investigate failures. If lane B never runs, all executed lanes can pass their guards while sync remains half-applied. The lane-pair telemetry entry is mandatory: keep B outstanding until it completes and the coordinator verifies agreement.

Failure modes/tradeoffs: legitimate concurrent edits also fail the lane; unreadable roots, files, invalid workspace configuration, or unresolvable Git state can block observation; hashing and Git calls add root-size-dependent overhead. Arbitrary undiscovered roots, ignored files, newly created roots outside the start set, and changes fully reverted before the final snapshot remain unobserved. There is no rollback or writer attribution. Historical artifacts lacked these baselines: 185 monitors and 70 telemetry records establish no historical clean bill of health.

Out of this handoff's scope: the requested A6.2 follow-up, B4b, and Phase D (proxy mode, zero-write/high-read cache behavior, first Astra usage measurement). Do not advance them without the next instruction.

Verification: full installed suite on `1.0.23+codex.20260912124950` completed with 68 passed, 0 failed (370.859 seconds). The 1.1.0 release changes version metadata and documentation only relative to that tested install; installed/source launcher and test bytes are verified identical. The global guard default and all model/effort settings remain unchanged.

GO: reload Direct `1.1.0+codex.20260912125840` and resume under the INTERIM single-root patterns. Pattern 2 requires per-invocation guard enablement, quiet monitored roots, and the coordinator's mandatory lane-pair ledger and final consistency check.
