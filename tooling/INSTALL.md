# Owner review decisions

The build-c skills and tooling bundle installs these scripts. The owner may
register an Ed25519 public key in SPKI PEM format as
`~/.config/trioharness/owner-decision.pub`. Use file mode `0600`. The CLI
accepts a regular file owned by the account with group and other writes
disabled. Keep the private key outside the tooling and agent workspace.

Run `team-review.mjs owner-decision --repo <checkout> --run <id>
--expected-head <commit> --decision hold --print` to emit the exact bytes to
sign. For a restart, use `--decision restart --replacement-run <unused-id>`.
Sign the entire output including its trailing newline with Ed25519. Run the
same command with `--signature <base64>` in place of `--print`.

The signature binds the disposition to the repository, run, head and current
refusal. Each run accepts one disposition. Recording it preserves the refusal
and all review gates. A restart names an unused run for the orchestrator.

The bundle stages `team-review.mjs`, `team-review.test.mjs` and
`arbiter.test.mjs` in `config/trioharness/skill-scripts/`. It stages
`arbiter-lib.mjs`, `team-lib.mjs` and `team-lib.nopins.test.mjs` in
`config/trioharness/`. The generated skill copy of the Arbiter is
`scripts/arbiter.mjs`. Stage `invoke-lane.mjs` and its test in the skill's
`scripts/` directory.
