# Team runs

This design extends the orchestration flow in [DESIGN.md §8](DESIGN.md#8-orchestration). A PM sends one approved plan to one Team. CodeDen starts one Architect session as the coordinator. The Architect chooses which eligible assignment to dispatch, when to request review and when to run final verification. CodeDen checks these actions against the run's recorded plan, Team and limits.

## Admission and Team selection

- Add a PM-scoped `start_team_run` MCP tool using the `StartTeamRun` contract. The PM supplies an optional `teamId` and exactly one of `planSha` or `checklistId`. Resolve the reference through the pinned-plan service and persist the approved immutable revision, including the checklist item IDs and dependencies. Keep existing project authorization, issue trust and overlapping-work checks at this entry point.
- Store a project Team list and its default ID in project settings. Migrate the existing project Team into a default entry, preserving its role overrides. Store the Team list and default together so that the default always points at an existing Team. Generate any required Drizzle migration on the current snapshot chain. An omitted ID selects the default. An explicit unknown ID refuses admission.
- Resolve roles from session overrides, then the selected Team, then global settings. Snapshot the resolved roles and caps for the run so project edits apply to later runs. Admission fails with an owner-visible reason if the plan is unapproved, a required role is absent, a required vendor is unknown or review would use the Writer's vendor. Use provider capabilities for vendor and isolation checks.
- Validate unique item IDs, known dependencies, and an acyclic graph before allocating anything. Enforce `maxAssignments` at admission. Reject requested assignments outside the pinned item set and use one durable assignment record per item.

## Dispatch and recovery

1. Record run admission and all queued assignments in the event log. Project them in the same transaction. Pin the Architect's and Writer's role selections and the assembler ref. Give each assignment its own branch and worktree based on the assembler tip at dispatch. Scope run tools to that run's Architect and worker tools to their assignment.
2. Reserve a dispatch slot before asking the runner to start a session. Count starting and running attempts against `maxParallel` and the existing active-session cap. Eligible assignments have completed dependencies. Treat `maxRounds` as the per-assignment attempt budget, including the initial dispatch and attempts following failed work or review findings. Stop retrying at the budget and surface the exhausted assignment.
3. Journal runner operations with stable run, item and attempt identities. Reconcile outstanding operations after restart before retrying them. Ignore late completion from superseded attempts. Replay events to rebuild state without launching sessions, merging branches or resending messages.
4. Store checkpoints with the assignment. On worker completion, failure or review completion, enqueue the corresponding app-authored coordination event. Deliver it to the Architect when its turn is free, with delivery deduplication by event identity. Use `continue` for an application-driven follow-up. Show a compact **Team** status row through the existing transcript projection. Only trusted application metadata selects that renderer.

## Review, assembly and verification

- Review each finished change against the approved item's scope and exact worker head through the shared review service. Require a different known vendor. Return reproducible HIGH and MEDIUM findings to the same assignment as a delta with its prior findings and receipt. Store LOW findings in tech debt with their original location and receipt.
- Invoke Jev after the item's final review and before assembly. Its receipt covers the reviewed commit and the recorded prefix of the item history. Route a product refusal to the reviewer once across the item's attempts, then raise an owner decision in the inbox. Show the result and receipt with each assignment.
- Serialize merges to the assembler. Merge the reviewed head through the RunnerPort. A conflict keeps the assembler tip intact, moves the assignment to waiting and raises an owner-visible notice. Record the conflicting refs with the checkpoint so the resolution can be reviewed against the corrected head. Never force-push. Mark an assignment completed only after both review and merge succeed.
- When every assignment is completed, run one full suite on the assembled head through the shared machine-wide lock with at most two workers. After it passes, run the resolved Browser Tester once on that head. Persist both results and mark the run ready for the owner only when both succeed. A failed check produces a notice with the result and leaves the run waiting.

## UI and verification

The project Team editor shows the list, default and per-Team roles and limits. The workers pane groups assignments by Team and run and displays status, attempt out of the maximum, and ETA when there is enough timing data. The checklist sidebar derives done/total and the current taskline from the same projection.

The PM tool is available by default. Admission refuses when pinned-plan lookup or model vendor metadata is unavailable. A run stops at an unavailable review or final verification service. Add Fake-provider tests that start two named Teams with different Architect and Writer models and caps, and verify each worker's model, branch and worktree. Use a scripted RunnerPort to exercise merge conflicts and verify that the assignment stays waiting. Rebuild projections from the event log and compare them with live state, including assignment completion, notices and progress. Verify that an unapproved plan, unknown Team and out-of-plan item are refused before runner work begins.
