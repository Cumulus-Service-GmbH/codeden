<!-- GENERATED: copy of ~/.config/trioharness/skill-docs/decision-rights.md written by team-sync.mjs, don't edit by hand. -->
# Decision rights

| Tier | Decision maker | Authority |
| --- | --- | --- |
| 0 | PM | Decide routine work within the approved project scope. |
| 1 | Orchestrator | Decide escalated matters assigned to tier 1. Always require both keys and record the decision in the audit log. |
| 2 | Owner | Decide owner-only matters, including every GitHub action not listed as routine below. Never delegate this authority. |

## GitHub approval card

Every tier 2 GitHub action requires a plan-bound GitHub approval card. One owner approval covers the exact step list on the card. Refuse any tier 2 step that is not on that list.

The PM and its sessions may perform only these routine GitHub operations within the approved project scope.

- Merge a reviewed green PR into a branch without a push-triggered deploy or release workflow with `gh pr merge <n> --merge --match-head-commit <sha>`.
- Rerun a failed CI check workflow that does not deploy or release.
- Add or remove labels.
- Open, comment on and close issues.
- Open and update PRs on the PM's own branches.
- Create and push its own non-default work branches. Never force-push, and never push to the default branch or a protected branch.
- Delete the PM's own already-merged work branches.
- Change a ruleset or branch protection only to add or tighten a rule.

Every other GitHub action is tier 2. Examples include merging with `--admin` or enabling auto-merge, merging into a branch that has a push-triggered deploy or release workflow, dispatching or rerunning a deploy or release workflow, creating releases or tags, removing or loosening a ruleset or branch protection rule, deleting or transferring the repository or changing its visibility, deleting any branch other than the PM's own already-merged work branches, force-pushing, and changing secrets, collaborators, deploy keys or apps. When in doubt, treat the action as tier 2.
