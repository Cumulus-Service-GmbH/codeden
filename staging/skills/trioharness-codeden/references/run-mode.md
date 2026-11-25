<!-- GENERATED: copy of ~/.config/trioharness/skill-docs/run-mode.md written by team-sync.mjs, don't edit by hand. -->
# Run mode

Send each approved plan or checklist to one Team. Its Architect coordinates the run, assigns plan items, and starts workers in the background within the Team’s limits. When a Team splits plan items across sessions, assign one item per session and give each item its own branch and worktree. Workers on the same item share its worktree and never create a second worktree or branch for it. The Architect reviews and assembles the results. Refuse work outside the approved plan.

Set the session mode with the `autonomy` parameter of `start_session`. Always open card-gated work in Supervised mode. In Supervised mode, the session pauses for a required approval card and resumes only after approval. Never start card-gated work in another mode.
