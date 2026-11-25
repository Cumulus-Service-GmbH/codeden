---
name: Stale PR follow-up
description: Weekday morning check of open pull requests with no activity for 5 days; rebases, fixes failing checks or answers review comments on CodeDen PRs, and nudges or summarises the rest.
trigger:
  type: cron
  expression: "0 8 * * 1-5"
action: start_session
workKey: automation:stale-pr-follow-up
title: Stale PR follow-up
autonomy: full
starter: true
requiresGithub: true
guards:
  overlapPolicy: skip-if-running
  maxPerDay: 1
---
You are running the **stale pull request follow-up** for {{project.name}} ({{date}}). Get stuck pull requests moving again without stepping on anyone's work.

## 1. Find stale PRs
- List open pull requests with `gh pr list --state open --json number,title,author,headRefName,updatedAt,isDraft,reviewDecision,statusCheckRollup,labels --limit 100`.
- A PR is **stale** when it has had no commits, comments or reviews for 5 days or more. Ignore drafts unless they are older than 14 days, and ignore PRs labelled `on-hold` or `do-not-merge`.
- Call `report_progress` with the number of stale PRs found.

## 2. Diagnose each stale PR (at most 6, oldest first)
Use `get_pr_status` and `gh pr view <n> --comments` to find out why it is stuck:
- **Merge conflicts** with the base branch.
- **Failing checks:** read the failing job logs (`gh run view --log-failed`).
- **Unanswered review comments** or requested changes.
- **Waiting on review** with everything green.
- **Abandoned:** the author's last message says they stopped, or the branch is far behind and the approach is obsolete.

## 3. Act
- **PRs opened by CodeDen** (branch starts with `codeden/` or the body links a CodeDen session): diagnose failures and recommend the next change. If you can fix the problem in your own worktree, submit the follow-up as a separate reviewed pull request against the fork. Link the original PR in the description. Keep the original branch intact.
- **PRs by people:** never push to them. Leave one polite comment with `comment_on_issue` that states what is blocking (conflict, failing check with the error, unanswered question) and the smallest next step. Do not comment again if CodeDen already commented in the last 7 days.
- **Green and waiting on review:** comment once asking for a review only if the repository's conventions allow pinging; otherwise just include it in your summary.
- Never merge, close or approve a pull request.

## 4. Finish
Call `finish` with a table: PR, why it was stuck, what you did, and what it needs next (from the user, the author or a reviewer).
