<!-- GENERATED: copy of ~/.config/trioharness/skill-docs/jev-evidence-format.md written by team-sync.mjs, don't edit by hand. -->
# Jev evidence format

Jev uses the `evidence` strings you send to judge whether a plan change is grounded or a done criterion is met. It reads no files and runs no commands. Write each string so a reader can see the command that produced it and its exact output. A claim the evidence doesn't show scores as unsupported, and a change the evidence doesn't ground scores as ungrounded. The thresholds don't change for documentation.

## Rules for every evidence string

1. Start with a pointer to what it supports and a short label: `criteria[0] (label)` for the `done` gate, `changes[2] (label)` for the `plan` gate. One string may cover several pointers (`criteria[0] and criteria[1] (label)`).
2. Put the exact command on the next line, then its verbatim output. Don't paraphrase, summarise or trim inside a quoted range. Keep git hunk headers exactly as printed, including any function context git adds after the second `@@`.
3. Pin every revision by its full SHA: the base, the candidate head and each blob you quote.
4. Claim only what the attached output shows. Leave out claims about steps that haven't run (for example a production action that is still pending).
5. Keep each string under 2,500 characters: quote the lines that matter, not whole files (Jev clips each item at 3,000 characters, keeping its head and tail).

## Evidence kinds

### Source or document excerpt (current text at a pinned revision)

Use it to show the current code, contract or document text that a change modifies or depends on (plan gate) or that a criterion is about (done gate).

```text
criteria[0] (current check), src/Endpoint.cs:62-63 at blob <blob SHA>
git rev-parse <base SHA>:src/Endpoint.cs
<blob SHA>
git cat-file -p <blob SHA> | nl -ba | sed -n '62,63p'
    62	    private static bool Allowed()
    63	    {
```

### Diff hunk (what the candidate changes)

```text
criteria[0] (step 6a wording), docs/plan.md:81
git diff --no-color --unified=0 <base SHA> <head SHA> -- docs/plan.md | rg '^@@ -81 |^\+For step 6a,'
@@ -81 +81 @@
+For step 6a, the operator confirms the revision is latest and ready.
```

### Text in the candidate (what the file says after the change)

```text
criteria[1] (resolved items kept), docs/plan.md headings
git show <head SHA>:docs/plan.md | rg '^## RESOLVED ITEMS|^- \*\*R[1-6] resolved'
## RESOLVED ITEMS
- **R1 resolved**. Step 4a defines the receipt required for cleanup.
```

### Proof run (the pinned proof command and its result)

```text
criteria[0] and criteria[1] (proof)
node <skill>/scripts/run-lock.mjs run -- python3 <run>/proof.py <head SHA>
Step 6a wording present: PASS
Resolved items preserved: PASS
```

### Review receipts (the completed review of this head)

```text
criteria[0] and criteria[1] (review receipts and finding count)
jq -c '{head,round,slot,status,invocationId:.evidence.invocationId,outputSha256}' <run>/CODE_REVIEW_ROUNDS.jsonl
{"head":"<head SHA>","round":1,"slot":"primary","status":"completed","invocationId":"<id>","outputSha256":"<sha256>"}
awk '/SEVERITY: (HIGH|MEDIUM) \|/ {n++} END {printf "HIGH or MEDIUM findings: %d\n",n}' <run>/workers/code-reviewer-1.md
HIGH or MEDIUM findings: 0
```

## Done gate (`jev.mjs done`)

The Team’s Architect runs done for each item after final review, any delta review, and any required owner decision. Use the folder of the skill you are running for `<skill>`. Invoke Node directly from the item’s worktree. Never use `eval` or shell indirection.

```sh
node "<skill>/scripts/jev.mjs" done <input.json> --log <run folder>/jev-receipts.jsonl
```

Only exit 0 with verdict `proceed` passes. Exit 2 means `revise` or blocked. Exit 3 means unavailable or bad input. Never pass `--attempt-repo` or `--attempt-run` to done. Those flags are plan-only. Done returns `ATTEMPT_FLAGS` and exits 3 if you pass them.

Pass a JSON object with `objective`, `criteria`, and `evidence` in that order.

- `objective` pins the candidate: `Verify the candidate at <full head SHA>.`
- `criteria` is an array of concrete product behaviours or wording users can verify. `evidence` is an array of strings. Jev rejects a criterion if it contains any of the following terms, matched case-insensitively. `trioharness`, `jev`, `gate`, `workflow`, `harness`, `code review`, `reviewer`, `fold`, `run-state`, `receipt`. It matches whole words anywhere in a criterion, including in file paths.
- Always cite the named tests that prove each criterion. Label each string `criteria[i] (label) tests at <head SHA>`. Include the exact test command, the matching verbose test lines, and the test-file and test-count totals. For docs-only changes, include a diff hunk or candidate text and a named proof check. Add a source excerpt for claims about current behaviour.
- Include the review receipt command and output shown above. Include the count of HIGH or MEDIUM findings in the latest review.
- Keep one history file per item. Include the pinned plan and acceptance criteria, each round’s writer response, the diff and its base and head SHAs, findings with severity, `failure_scenario` and repro, any owner decision on a disputed HIGH or MEDIUM finding, and earlier Jev results with reasons. Pass the history by path. For the reviewer, append the committed history to the brief and omit its frozen diff.
- Include the history path through the exact `shasum -a 256` command and its output. Include command output showing the HIGH and MEDIUM finding IDs from each earlier round and the latest count. Use command output as evidence.
- Record the history path and its SHA-256 with the Jev receipt. Bind the receipt to the full item head SHA. Never merge without a pass for that SHA. Run a new gate when the head moves.
- On a product refusal, return the item to the reviewer once. If Jev still refuses, route it to the owner as an “owner decision” in the orchestrator inbox.

## Plan gate (`jev.mjs plan`)

Input: `{ "objective", "criteria", "changes", "proof", "owned_paths", "evidence" }`. Each `changes[n]` is `{ "file", "change" }`.

- Ground every change: give a source or document excerpt of the file `changes[n].file` edits, at the pinned base, labelled `changes[n]`. For a docs-only plan, the current text of the document is the grounding.
- `proof` names the RED command and the final command. For docs, the same working-tree check can fail before the change and pass after it. Use only revisions available at plan time.
- Tests, verification and the documentation of a needed change count as part of that change.

```json
{
  "objective": "Mark the former probe obsolete in docs/plan.md at base <base SHA>.",
  "criteria": ["docs/plan.md step 6a says the former probe is obsolete and keeps the current check."],
  "changes": [{ "file": "docs/plan.md", "change": "Replace the step 6a probe sentence with the obsolete note; keep the current check." }],
  "proof": ["RED: node <skill>/scripts/run-lock.mjs run -- python3 <run>/proof.py <base SHA>", "Final: node <skill>/scripts/run-lock.mjs run -- python3 <run>/proof.py <head SHA once built>"],
  "owned_paths": ["docs/plan.md"],
  "evidence": [
    "changes[0] (current step 6a text), docs/plan.md:80-82 at blob <blob SHA>\ngit rev-parse <base SHA>:docs/plan.md\n<blob SHA>\ngit cat-file -p <blob SHA> | nl -ba | sed -n '80,82p'\n    80\t## Step 6a\n    81\tRun the former probe.\n    82\tKeep the current check."
  ]
}
```

## Code claims

A claim about code behaviour, tests or builds needs command output or test results. Quoted file text shows what the code says, not that it works, so pair it with the test or command run that proves the behaviour.

## Frozen packets for new CodeDen runs

Use the owner-approved requirements JSON with `objective`, `criteria` and an immutable `model` version. Record its full SHA-256 from the owner approval. The first submission fixes this digest for the run. A later requirements change needs a newly approved run.

Pass `--requirements <file> --requirements-sha256 <owner digest> --source-sha256 <current source digest>` with the run log to both `plan` and `done`. Compute the current source digest from successfully generated bytes. Keep external generation and digest calculation in the same failing command sequence. The CLI constructs the packet from the current source in memory. It refuses prebuilt packets and fails before dispatch if any evidence reference is missing.

- Plan input has `changes[{file, change, claims[{criterion, evidence[]}]}]`, `evidence[{file, excerpt}]`, `checks[{check, before, after, evidence[]}]` and `proof[{phase, command, expected}]`. Criterion and evidence references are zero-based. Each claim cites the file changed. List the checks affected by the plan, including relocated or replaced checks.
- Done input has `baseline {base, head, diff}` and `runs[{phase, command, exit, output, criteria[]}]`. Use full Git SHAs and the literal output of `git diff --no-ext-diff --no-textconv <base> <head> --`. Set `phase` to `red` for expected pre-fix failures or `final` for acceptance runs. Keep the entire output including RED failures. Every criterion needs a successful final run.
- To replay without a service call or receipt, pass `--shadow <file>` with a fixture containing `model` and `answers`. The command reports the rubric, model, verdict and reasons.
- Before plan arbitration, freeze the exact JSON judged by Jev. Use the plan command with `--dry-run --show-state` and save `request.state` as the Arbiter's `--subject`. Keep the subject and the ruling's report in the run. A verified final APPROVE closes the bound plan before a round cap or model call. A changed subject, different packet or BLOCK stops that route.
- At the cap, run `gate-exception.mjs card` with the same source, requirements flags and `--receipts <run log>`. Send the returned `codeDenCard` to CodeDen's ask-user tool. Record the owner's actual selection on the matching question set and run `grant` with the same source and requirements flags. Submit with `--exception-repo` and `--exception-run` to redeem the approval once. It uses the exact rejected packet and spends no model round. A renewal card authorizes one real dispatch and never grants a pass by itself.
