# Question cards, the intake interview, and repo knowledge

Load this when you must ask the user something, when the request is vague, at the start of a run in a repo that has `docs/agent-knowledge/`, and at the learning step. Its rules are binding.

## 1. Question cards (the only way to ask, and the run stops)

A **blocking** question is asked as a card and nothing else: no prose question, no "I'll assume X and carry on", no free-text field. A **non-blocking** question is a note in the task card's Assumptions list; work continues.

Card file (JSON), 1–4 questions, each 2–4 fixed options, exactly one recommended (several only with `multiSelect`), a one-line reason; the sole no-recommendation exception is the unchecked failure card specified in points 1–7 below:

```json
{ "questions": [ {
  "id": "q1", "header": "Scope", "multiSelect": false,
  "question": "Should the fix also change the mobile app, or only the web API?",
  "options": [
    { "id": "a", "label": "Web API only", "description": "Smallest change; mobile keeps the old behaviour until its own task." },
    { "id": "b", "label": "API and mobile", "description": "One change set, but adds the mobile build and store review to the proof." }
  ],
  "recommended": "a",
  "why": "The mobile client already ignores the new field (apps/mobile/src/api.ts:88)."
} ] }
```

Rules the script enforces: header ≤ 12 characters; the question ends with `?`; labels ≤ 60; every option has a description (its consequence); no option may be "Other", "Something else", "Custom", "Free text" and the like; `recommended` names real option ids; `why` is required; no secrets in the text.

## Card recommendation check (points 1–7)

Fixed cards built by harness scripts (gate-exception, secrets, clean-state, running-ref, issues) are exempt from the card check; only Architect-authored cards are checked.

1. Before showing an Architect-authored blocking card, the Architect runs `node "<skill>/scripts/card-check.mjs" <card.json> <evidence.json>` with the approved criteria, earlier owner answers and source excerpts in `{ "items": [{ "label": "path:lines", "text": "verbatim excerpt" }] }`. One child invocation of `jev.mjs check` covers all 1–4 questions; Jev may retry HTTP internally. This uses the existing check gate and thresholds, not a new gate or role.
2. Contract version `1` asks the six questions below in order, expecting **yes, yes, yes, no, no, no**. For multiple questions, “recommended option” becomes “recommended option(s)”. Evidence starts with the card itself, rendered verbatim as `CARD: question / options a..d with descriptions / RECOMMENDED: id / WHY: ...`, followed by supporting excerpts. Jev judges from evidence only.
3. A pass requires exit 0 and parsed JSON with `gate:"check"`, `verdict:"confirmed"`, `pass:true`, no `dryRun`, a 16-hex `inputSha256` and receipt timestamp `at`. Put `receipt:"check-<inputSha256>-<at>"` on each checked question; both renderers show it beside the recommended option. A successful exit alone never confirms a recommendation.
4. On not-confirmed, unavailable, malformed output or timeout, the Architect may revise the recommendation/evidence **once and recheck once**. If still unconfirmed, show **no recommendation**. The only exception to “each card has a recommended option” is `recommended:null` together with `unchecked:true`; keep `why` within 300 characters as a bounded failure summary (for example the first three reasons truncated plus `full reasons: <path>`). Full failure reasons are written to `<cache-dir>/<digest>.reasons.json`; use the returned `reasonsPath`. Both renderers show `Not recommended (unchecked): ...`, with no Recommended badge or “Recommended because” wording. Unchecked questions are never assumed, including multiSelect: interactive and unattended cards stay open; autopilot defers the whole card as a gate, and `promote` opens it for the owner.
5. Default hard timeout is **20000ms (20s)**; `--timeout-ms` must be a finite integer in **1..20000**, otherwise refuse without a call. At the deadline send **SIGKILL** and return without awaiting close beyond 1s. Exit 0 means pass, 2 not-confirmed, 3 unavailable/timeout/refused. The helper prints one JSON line with status, receiptId, reasons, cached and elapsedMs (and reasonsPath for persisted failures).
6. Cache only passes under `~/.trioharness-lean/card-check-cache/` (override `--cache-dir`); the digest binds SHA-256 of contract version + the six questions + complete card + evidence. Cache reads validate the contract, digest and full confirmed Jev result; a valid hit makes no child call (`cached:true`). Failures are not cached verdicts; their reasons files do not authorize additional attempts beyond the one revise+recheck.
7. Bound the final serialized UTF-8 state to **24000 bytes (24KB)**. Cap supporting evidence items at 2500 characters and trim evidence tail-first with `[trimmed]`; refuse if card text alone exceeds the budget. Also refuse without a call when the rendered card (`evidence[0]`) exceeds 2500 characters: shorten options/why, or show the card with no recommendation. This keeps the verbatim card below unchanged Jev evidence clipping. **No secrets:** scan every decoded string field (including labels, card fields and evidence that would be trimmed away) with `findSecrets` before trimming, then scan serialized state again. Refuse hits before sending; never echo matched text or raw child stderr. Never read credential files to prepare this evidence.

The six literal questions are:

1. Is the recommended option consistent with the approved criteria and earlier owner answers quoted in the evidence?
2. Does the recommended option stay within the authorized scope quoted in the evidence?
3. Is every factual statement on the card (question, option descriptions, why) supported by the quoted evidence?
4. Does any option other than the recommended one better satisfy security, efficiency, complexity and risk at equal or lower cost?
5. Does the recommended option skip, loosen or override a gate, test, review finding or authorization rule?
6. Does the recommended option introduce an unreviewed security or data-loss risk?

Follow-up: PandaCode/app-side enforcement is out of scope for this change; these script and Architect rules do not establish app enforcement.

Flow, every time (after the recommendation check):
1. `node "<skill>/scripts/questions.mjs" ask --repo . --run <id> --file <card.json>` — validates, records `Q-<n>` as **open**, prints the card in host form (recommended option first, marked "(Recommended)", `allowFreeText:false`).
2. Show it with the host's card tool (table below). Then `run-state.mjs set --gate <current> --status blocked --next "awaiting Q-<n>"` and **end the turn**. Start nothing else.
3. While a card is open, `run-state.mjs` refuses to pass or start any gate, to dispatch or register a worker, and to `finish`; `questions.mjs check` exits 2 (end the turn); `stalled` does not report the run (it is waiting for the user, not dead).
4. The user's selections come back as option ids: `questions.mjs answer --run <id> --set Q-<n> --answers '{"q1":"a"}' --via card|ui|numbered-reply --quote "<verbatim>"`. Every question must be answered, only with the card's own option ids; anything else leaves the card open — ask again with a better card, never interpret a free-text reply as an answer. Record the decision in the ledger and resume at the recorded gate.
5. A card that became moot (the user withdrew the task, another answer settled it): `questions.mjs cancel --set Q-<n> --reason "<why>"`.

| Host | How the card is shown |
|---|---|
| PandaCode fork (cumulus build) | the app's question-card UI, fed by the architect's card tool or by the provider's own question tool; fixed choices, a Recommended badge, pre-selected recommendation, no "Other" field |
| Codex | `request_user_input` with `isOther:false` |
| Claude Code | `AskUserQuestion` (recommended option first, label ending "(Recommended)") |
| No card tool (plain terminal, Bambooed) | `questions.mjs render --set Q-<n>`: numbered options with the recommendation; the reply must be option numbers |

**Workers never ask the user.** A worker that needs a decision writes `QUESTIONS NEEDED` (the question, the options it sees, what it would recommend) in its result file and stops; the Architect turns that into a card. If the host lets a worker call a question tool anyway, the Architect treats any answer obtained that way as not given and asks again on a card.

## 2. Conditional intake exploration (when the request is vague)

Method adapted in spirit from the `interview-me` skill in addyosmani/agent-skills (MIT); this harness carries its own version so it never depends on another skill or a slash command being available. If a skill named `interview-me` happens to be installed and your host lets you invoke skills yourself, you may use it to sharpen the questions, but the result still goes through a card; never wait for a slash command.

Read brainstorming at standard tier; use conditional intake exploration within the existing intake budget, not a routine interview. A clear request gets no interview. Blocking questions use the card below; non-blocking choices stay assumptions. Interview only when **all** hold: the outcome cannot be written as a testable acceptance criterion from the request and the code; two or more plausible readings would change scope, a public contract, data, cost or risk; and reading the code, tests, docs and the knowledge base cannot settle it. Then:
1. Read first. Answer from evidence everything you can (with `path:line`), and list what is still unknown.
2. Keep only unknowns that block. Rank by how much the answer changes the plan. Everything else becomes an Assumption in the task card.
3. One card, at most four questions, most scope-changing first. Each option states its consequence. The recommendation is grounded in evidence cited in `why`.
4. After the answers, restate **Outcome, Non-goals, Files, Proof** in the task card with the decisions, and continue. Never interview twice for the same ambiguity; a clear request (REPO / TARGET / TASK given, acceptance criteria stated) gets no interview.
5. Unattended runs are marked by a file only a human or a scheduler writes (`<repo>/.trioharness-direct/UNATTENDED`, or `runs/<id>/UNATTENDED`): never the agent, never the card, never an environment variable. In such a run `ask` records a checked card as `assumed` with every recommended option and does not stop; record "assumed, unattended" in the ledger and the final report, and do nothing irreversible on that assumption. An unchecked card stays open. In every other run the card stops the run, even when the user seems to be away.

## 3. Repo knowledge (`docs/agent-knowledge/`)

What earlier runs verified, kept in the repo so the next run does not repeat the investigation. Created once, with the user's agreement, by `knowledge.mjs init`. Entries are files, `entries/K-YYYYMMDD-<slug>.md`; `INDEX.md` is generated and lists approved entries only (≤ 150 lines).

Entry: single-line JSON frontmatter `id, title, topic (build|test|env|deploy|fix|pitfall|decision|protocol), status (proposed|approved|rejected|superseded), risk (low|high), created, run, author, approved_by, approved_at, last_confirmed, superseded_by, files[], verify`; body sections `Symptom`, `Cause`, `Fix`, `Evidence`.

- **Start of run (gate 1):** `knowledge.mjs find --repo . --files <owned or suspected paths> --q "<task words>"`. Read the hits; cite the K-ids in the ledger; do not re-investigate what an approved entry covers, but run its `verify` command (through `jobs.mjs`) when the plan depends on it. A `risk: high` entry is confirmed with the user before you rely on it.
- **During the run:** an entry you re-prove → `knowledge.mjs confirm`. An entry that is false now → propose a new entry that says so; the user supersedes the old one.
- **Learning step:** propose entries for facts this run verified and a future run needs: a fix for a failure that cost time, a required setup, a deploy or protocol detail, a pitfall, a decision with its reason. Each carries `Evidence` (command output or `path:line`), `files` it concerns and a `verify` command when one exists. Do not propose: task history, opinions, anything unverified, anything already in AGENTS.md, anything secret. `knowledge.mjs add …` then `knowledge.mjs gate --run <id>` (or `--none "<why nothing new, 20+ characters>"`); a repo with the folder cannot pass `learnings` without it.
- **Approval is the user's.** Agents only propose. `approve`, `reject` and `supersede` refuse unless a person is at a terminal (or the PandaCode Knowledge tab does it). Entries are never deleted or rewritten after approval: reviewers run `knowledge.mjs check --base <default branch>`, which fails an edited or deleted approved entry, a forged approval, a stale index and any secret-looking text.

## 4. Standing orders (decisions already made are not asked again)

The same decisions came back as cards run after run. A **standing order** records one of them once, in the user's own words, and the skill then answers that kind of card itself, writes down that it did, and continues. It is for routine, reversible choices only.

- **What can be an order:** a card topic the skill builds itself, with one option id: `runningref a`, `supersede a`, `closesuper a`, `defect a|b`, `skips a` (`standing-orders.mjs list` prints the orders in force; one order per topic, a new one replaces the old). An order is applied only when **every** question on a card has one; otherwise the card is shown as usual.
- **What is never an order, whatever is recorded:** merges, deploys, production anything, secrets and credentials, deletions, force operations, guard or secret-scan exceptions, spending. (In CodeDen, merges and other GitHub operations need no card at all: SKILL.md gate 9.) Such topics (and anything about Jev gates or exceptions) are refused when an order is added and ignored if one is found.
- **Recording one:** only when the user says so in their own words ("always base on main and leave the environment alone"). `node "<skill>/scripts/standing-orders.mjs" add --repo . --topic runningref --choice a --reason "<why>" --quote "<the user's words, verbatim>"`. A repo-scope order is a file in the repo (`.trioharness/standing-orders.json`) and goes in through a reviewed pull request; a user-scope order (`--scope user`) lives in `~/.config/trioharness/standing-orders.json` and covers all repos. An order can have `--expires`. `remove` ends it.
- **Visible, not silent:** a card answered by an order is recorded as answered via `standing-order`, naming the order id (the order itself holds the user's quote and reason); the final report lists every order applied ("Applied standing orders: SO-3 runningref a (quote)"), so a returning user sees what was decided on their behalf.
- **Honest limit:** an order is a file; a process running as the same user could edit it. The repo copy is reviewed like code, and the never-list is enforced when an order is read, not only when it is written.

## 5. Autopilot (2.36): no jams, one report

The user asks for it in their own words (`questions.mjs autopilot --on --quote "<their words>"`; never from your own judgement). Cards are then split by kind. **Execution** questions (scope, naming, ordering, a reversible implementation choice, the skill's own routine topics) are answered with the recommended options, recorded as `assumed` (`answeredVia: autopilot`) and the run goes on. **Gate** questions are `deferred`: nothing gated is done, the run does not wait, independent work continues. Wording forces the kind (merge, deploy, production, secrets, credentials, keys, release, publish, delete, spend, rotate, purge, permissions, roles, rulesets, branch protection, repo/Azure settings, migrations, guard or allowlist exceptions, Jev gates, approvals), whatever label the card carries, and a card that mixes kinds is refused (`AUTOPILOT_MIXED_CARD`): split it. `questions.mjs deferred` lists what is parked; `questions.mjs promote` merges every parked gate (4 questions at most, one parked card is never split) into ONE open card, and its answer settles each parked card. `run-state.mjs` records `awaitingApproval` when the run finishes with parked gates. The final report lists every assumption (`autopilotReport`) and what waits. Honest limit: the marker is a file a same-user process could write; the quote requirement makes it a recorded, reviewable act, and the gates themselves (`deploy.mjs`, `merge-verify.mjs`, the server rulesets) do not depend on it.

## Honest limits (what is enforced where)
- The scripts stop a run that plays by the rules: gates, dispatch, worker registration, `finish`, job start, closeout, worktree registration and reuse all refuse while a card is open. A process running as the same user can still edit the files, call `answer`/`cancel` itself, write the `UNATTENDED` marker, set `THL_KNOWLEDGE_APPROVER`, or strip the agent marker from a push. No script can prevent that.
- The real stop is the host: in the Cumulus PandaCode fork the app owns the card (it keeps the turn open, accepts only the card's own option ids, and re-shows the card after a restart), so an answer can only come from the user. Approvals of knowledge entries are visible in the diff (`approved_by`, `approved_at`) and are reviewed in the pull request.
- Required server-side controls (not scripts): a ruleset on the default branch (no direct pushes, pull request required, no force push). The local pre-push hook is a guard rail.
