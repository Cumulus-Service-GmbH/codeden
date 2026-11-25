<!-- GENERATED: copy of ~/.config/trioharness/skill-docs/review-flow.md written by team-sync.mjs, don't edit by hand. -->
# Review flow

1. Run one final cross-vendor review per item. Never use a reviewer from the writer’s vendor. Claude reviews only code written by the Team Writer.
2. The review guide asks for `FAILURE_SCENARIO` and `REPRO` on every HIGH or MEDIUM finding. Record a HIGH or MEDIUM finding missing either field as LOW. Dismissing a HIGH or MEDIUM finding still requires Jev `finding`.
3. Send fixes for delta review. Give the reviewer only the fix diff and the findings it answers.
4. Until the Arbiter ships, send any HIGH or MEDIUM finding the reviewer and writer still disagree on after delta review to the owner as an “owner decision”.
5. Run Jev done with the per-item history file after review. Require a pass for the current head before merge. On a product refusal, return the item to the reviewer once. Route a repeated refusal to the owner as an “owner decision”.

Always record LOW findings verbatim in the run’s `tech-debt.json`. Never drop them or let them block delivery.
