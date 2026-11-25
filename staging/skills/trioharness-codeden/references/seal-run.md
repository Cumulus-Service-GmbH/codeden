# Seal run: one repository, end to end, until the deploy gate

Load this when the user asks for a team to run a repository "end to end", on "autopilot", or to "seal" it. It chains rules that exist elsewhere; nothing here lowers a gate. The user is told once at the end (everything merged, only the final approval left) and is asked before that only for a real execution question.

## 0. What the task prompt must say (exact authorization naming the repo)

The Architect acts on GitHub only with explicit authorization naming the repository. A seal prompt therefore names: the repo, the work queue (issues/PRs), that GitHub setup is authorized (`github-setup.mjs audit|converge|verified-merge`, the `merge-verify` install PR), that autopilot is on (the user's own words become `--quote`), and the decisions already made (never re-asked). Without that authorization do steps 1-4 as plans and ask one card.

## 1. Orient (no writes)

`repo-shape.mjs` and `running-ref.mjs check` as always (gates 0, 0b). Inventory open runs, branches, PRs and pending cards of the repo; continue what exists, never start a second run on the same work. `github-setup.mjs audit --repo <slug> --reference <slug of a healthy repo>` lists every gap with its fix.

## 2. GitHub baseline (the Architect, once per repo)

- `github-setup.mjs converge --repo <slug> --reference <slug> --confirm` fills in what is missing from the bootstrap baseline on the existing repo: merge settings, the baseline rulesets, vulnerability alerts, secret scanning and push protection. It never creates a repository, changes visibility or deletes anything. Anything GitHub refuses is reported as an owner step.
- Missing repo files (AGENTS.md, CI workflow, PR template, `.trioharness/*`) come from the bootstrap pull request (`references/bootstrap.md`), not from this script.

## 3. The setup pull request and its one approval

One task branch `bambooed/<run>-seal-setup`, one PR, containing: the bootstrap files that are missing, `merge-verify.mjs install --repo .` (the required check `merge-verify`, its three helper files, `.trioharness/merge-policy.json` with `enabled:true`), and, only if the repo deploys on a push to its default branch (a plain PR later says `DEPLOY_ON_MERGE`), the fix that makes that deploy manual or environment-gated (`templates/repo/github/deploy-guard.example.yml`). Every one of those paths is sensitive, so this PR waits for the user's approval card: it is the ONE setup stop. Ask a normal card ("Approve and merge the setup PR #N?"), end the turn, and continue at the answer. Autopilot is switched on only after this step.

## 4. Prove it, then switch

Open a small docs-only PR (for example a line in `docs/agent-knowledge/`) and let `merge-verify` run on it. When the check has passed on a real PR, `github-setup.mjs verified-merge --repo <slug>` prints the plan; with the task prompt's authorization run it with `--confirm`: the "Verified merge" ruleset is added first (the old bypass actors copied), then the manual approval ruleset is disabled (never deleted). Keep the printed rollback line in the ledger. Merge the proof PR with `merge-verify.mjs merge` (it is the first verified merge) and run `merge-verify.mjs post`.

## 5. Work the queue on autopilot

`questions.mjs autopilot --on --quote "<the user's words>"`. For every item: worktree, implementation by workers, guard and proof, review and the Jev gates as the tier requires, push, open the PR (all by the Architect), then `merge-verify.mjs merge ... --wait-checks-sec 900` and `merge-verify.mjs post`. A PR that does not pass (sensitive path, dependency or migration change, a deploy on merge, a failing check) is not merged: its reason is the gate card, which autopilot parks; continue with the next independent item. Dependent items that need it wait; never stack a workaround. Dependency bumps are validated for breaking changes before the PR exists (changelog, major version, removed APIs, build and tests) and then still go through the approval card.

With the "Verified merge" ruleset on, a sensitive PR passes the required `merge-verify` check only after a person approves it on GitHub: an owner, member or collaborator (not a bot, not the PR author) approving THAT head, and only when every remaining reason is a person's call (sensitive path, size, branch name, the missing PR section; never a failing or pending check, a deploy on merge, a secret, fewer tests, a moved head). A review does not re-run the check, so after the approval run `merge-verify.mjs recheck --repo <slug> --pr <n>` (or press Re-run on the check); a `RERUN_FORBIDDEN` answer means the bot's GitHub App needs "Actions: Read and write", which the owner grants. The Architect's own `merge-verify.mjs merge` still never counts approvals.

Issue status moves only by verified facts; an `ADOPT_LOCKED` refusal is parked for the owner like a gate card, never cleared by autopilot.

## 6. The end: one report, one final approval

QA deploys run through `deploy.mjs` as the repo's `deploy.json` allows; production never. Then: `clean-state.mjs check`, closeout, learnings. Then `questions.mjs promote` (one card with every parked gate: unmerged sensitive PRs, deploy, anything else) and the final report, at most 15 lines: what is merged (PR numbers), what autopilot decided (`autopilotReport`), what waits for the final approval, and the rollback line for the GitHub switch. Nothing else interrupts the user.

## Stop conditions (a stop is a report, never a retry loop)

`POST_ATTENTION` (a deploy started, the default branch red, the merge not on it) stops merging in this repo: report, fix forward through a verified PR, no revert, no direct edit. A refused `merge-verify merge` (`MERGE_REFUSED`) or a server rule that blocks a merge is never worked around. A failing baseline that the policy does not allow, a leaked secret finding, or a live-code risk stops the item and goes to the user.
