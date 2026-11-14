# How the factory loop works

What the software factory and the dark factory do between the events you see: when work starts, why pull requests merge one at a time, what "Loop building" means, and what still comes to you. Every number here is the default; most can be changed in the factory **Settings**. For the full reference (every setting, merge check and API route) see [The software factory and the dark factory](software-factory.md).

```text
 Issue: yours, a trusted author's
 or (dark factory) the scout's
   │
   ▼
 Identify type
   │  waits for a free agent
   ▼
 ┌──────────────────────────────┐
 │ Bug: Reproduce ► Create fix  │
 │ Feature: Analyze ► Implement │
 │ Docs: Implement docs change  │
 └──────────────────────────────┘
   │  opens a pull request
   ▼
 Review, merge checks, CI ◄───┐
   │  changes asked ► Revise ─┘
   ▼  approved, every check green
 Merge: by you, or the queue
   │
   ▼
 Watch CI on main
```

## The factory loop

The factory is a loop on the CodeDen server. It runs a **pass every 30 seconds**, and also right after something happens: a factory agent finishes a turn, a pull request changes, or you press a button. The panel's last line says when the last pass ran.

One pass, in order:

1. **Kill switch.** If one is on, the pass stops here: nothing moves and nothing merges.
2. **A new day.** At midnight (local time) it writes the daily digest, resets today's merge count, and lifts a pause caused by the daily budget.
3. **Tidy up.** Work whose issue was closed on GitHub is settled, and work that failed for a reason outside its code (a session that died, a provider that dropped out) is put back.
4. **Move every item one step:** CI watched on the default branch after a merge, builds, reviews and merge checks, then **at most one step of the merge queue**.
5. **Clean up.** Pull requests replaced by newer ones are closed, and finished work's sessions are archived.
6. **Budget.** If today's spend reached the daily budget, the loop pauses.
7. **Intake.** New issues become work items, and up to 3 per pass are sorted into a pipeline.
8. **Free agents** get work (see [Agent slots and priority](#agent-slots-and-priority)).
9. **The scout** (dark factory only) starts a round if one is due.

### What the header says

The chip in the factory panel and the Factory view shows the loop's state as **Loop** and one of:

| State | Means |
|---|---|
| **Verifying** | Something is in review, in the merge queue, or having CI watched on the default branch. This wins over Building. |
| **Building** | Agents are building, and nothing is in review. |
| **Scouting** | Only the scout's round is running (dark factory). |
| **Idle** | Nothing in flight. The loop still runs its pass every 30 seconds. |
| **Paused** | The loop paused itself. The reason is shown with it. |
| **Stopped** | A kill switch is on (the project's or the global one). |

The loop **pauses itself** for one of these reasons:

- **The daily budget is spent** ("daily budget reached ($10.00 of $10.00)"). It resumes by itself the next day.
- **Failures in a row**: 3 failed items or reverts in a row ("3 failed merge checks or reverts in a row").
- **A regression**: CI on the default branch failed after an automatic merge, and a revert pull request is open.

While paused, work already in flight keeps moving (builds and reviews finish), but nothing merges except a revert. Nothing new starts: no intake, no new builds, no scout round, no automatic recovery or re-review. **Resume** clears the pause and the failure count.

**Finishing open work (2 of 2 PRs open)** beside the state means the open pull request limit is reached (see [Agent slots and priority](#agent-slots-and-priority)).

## The pipelines

### Intake and classification

- **What's taken on.** An issue opened on GitHub after you switched the factory on, or one labelled `codeden-factory`. Only issues by **trusted authors** are taken on: the GitHub account CodeDen uses, and the logins under **Trusted authors**. Everyone else's are listed as ignored, untouched, until you click **Let in**.
- **Identify type.** A GitHub label decides it (`bug`, `enhancement` or `feature`, `documentation` or `docs`). Otherwise one quick call to the utility model sorts it, and with no model available, keywords do. The issue gets a `factory:bug`, `factory:feature` or `factory:docs` label and a comment with its pipeline.
- **Waiting for an agent.** The item is queued until an agent is free.

### Reproduce or analyze, then implement

Each item gets its own agent session in its own worktree.

- **Bug.** The agent writes a failing test (or a probe) that shows the bug. If it can't, the work stops and the issue asks for what's missing. Otherwise the same agent makes the test pass and keeps it as a regression test.
- **Feature.** The agent checks whether it already works and fits the vision, then posts a spec with acceptance criteria on the issue. A request that already works, is unclear or is out of scope stops with a comment. Otherwise the same agent builds it to the spec.
- **Docs.** The agent makes the change straight away.

Every pull request carries its test results, and screenshots when UI files changed.

### Review

- **The independent reviewer** is a separate agent session, on a different provider from the builder when one is available (see [Reviewers and providers](#reviewers-and-providers)). It checks the pull request against the issue, the spec and the vision. A docs change that touches only documentation skips it.
- **The merge checks** run beside it: protected areas, size, CI, review, tests, test results, security and screenshots. CI on the pull request is the authority for the full test suite.
- **Revise rounds.** A review that asks for changes, or a failed check, sends the work back to the same builder to fix in the same branch: up to **2 revise rounds**. After that the item stops (see [When things go wrong](#when-things-go-wrong)).

### Merge

With every check green:

- **Auto-merge off** (the default): the pull request is **ready for you**. You get an inbox item and a comment on the pull request, and it waits in **Needs you** until you merge it on GitHub.
- **Auto-merge on**: trusted work joins [the merge queue](#the-merge-queue). Work let in from an untrusted author always waits for you.

### Watching main after a merge

After an automatic merge the factory watches CI on the default branch for up to **120 minutes**:

- **Green**, or no CI after 10 minutes, or still running after 120 minutes: the work counts as merged.
- **Red**: a regression. The factory opens a revert pull request, counts a failure and pauses the loop. The revert goes to the front of the merge queue, and may merge while the loop is paused.

## The merge queue

With auto-merge on, a pull request whose checks all pass doesn't merge on the spot. It joins a queue, and the factory merges **one pull request at a time**:

- **Order:** a revert goes first, then the pull request whose checks passed first.
- **Only the head of the queue acts.** The others say "queued to merge (number 2 in line)".
- **Behind the default branch?** The factory asks GitHub to update the head pull request (**Update branch**, pinned to its current head commit). No agent and no new review is needed. CI then runs on the new head.
- **Merged on a later pass** once CI on that head is green: a squash merge, again pinned to the head commit, at most one per pass.
- **Held** while the loop is paused (reverts excepted), when today's merges reached **Auto-merges per day** (5), and while a kill switch is on.

**Why one at a time?** Every merge changes the default branch. A pull request that passed CI against the old default branch hasn't been tested against the new one, so each pull request is updated and tested on top of the one before it. Merging several at once could merge two changes that each pass alone but break together.

**How long a merge takes.** About one CI run of your repository, plus up to 30 seconds for the next pass to see it: the head is updated, CI runs, the next pass merges it. With a 10-minute CI, five queued pull requests take about 50 minutes.

**Merge conflicts** aren't a queue problem. The pull request's builder is asked to rebase and resolve them (this isn't a revise round), up to 3 times. If it still conflicts, the work is rebuilt once from the latest default branch.

## Agent slots and priority

**Agents at once** (2) caps every factory agent working at the same time: builders, reviewers, the scout and its area reviewers. Work in progress is never interrupted; only the next free agent is decided. When an agent is free it goes, in this order, to:

1. a reviewer for a pull request whose CI passed;
2. a rebase, a conflict resolution or a revise round;
3. a reviewer for a pull request whose CI is still running;
4. a builder carrying on after a failure outside its code;
5. a new build from the queue;
6. the scout and its area reviewers.

Within each, what waited longest goes first. **Reviews, fixes and rebases come before new builds**, so open work finishes before more starts. (Merging needs no agent: the loop does it.)

**The build queue's order:** a fix for a failing check on the default branch (and a revert) first, then the issues you and trusted authors filed, then the issues the scout filed. Within each, by priority, then oldest first. An item whose issue names files that an open factory pull request changes waits behind items that don't.

**PRs open at most** (the open pull request, or work-in-progress, limit: by default the same as Agents at once). With this many factory pull requests open, no new build starts and the scout files nothing; free agents go to reviews, fixes and rebases until one merges or closes. Builds that haven't opened their pull request yet count too. A fix for the default branch still starts. Pull requests of failed or escalated work, which wait for you, don't count.

**Auto-merges per day** (5) also limits builds: with auto-merge on, today's merges plus trusted work being built or verified stay under it.

## Reviewers and providers

**Who reviews.** With the reviewer provider on **Automatic** (the default), the review runs on a different provider from the builder's: Codex reviews Claude Code's work and Claude Code reviews Codex's, or any other available provider. With only one provider installed, the review runs on it and the item notes that. You can pick a provider and model in the factory **Settings**, under **Agents**.

**Available** means a provider can take new work now. It isn't when:

- it isn't installed, or the runner doesn't offer it;
- its CLI is older than CodeDen needs;
- it's signed out;
- it's at its usage limit (until the reset, or an hour when the reset time isn't known);
- a factory session just failed on it because of the provider (it couldn't start or sign in): it's skipped for 30 minutes, then tried again.

Providers are checked again every few minutes.

**When the reviewer's provider isn't available,** the **When the reviewer's provider is unavailable** setting decides:

- **Review on the builder's provider and model** (the default), in a fresh session;
- **Review on any available provider**;
- **Wait until it is available again**.

With no provider available at all, the review waits, and the item says until when.

**Builders** whose provider isn't available start on another one: the project's provider, then the agent role's, then any available one.

## When things go wrong

### Revise rounds and stopped work

- **After 2 revise rounds** the item stops with its pull request still open, and counts toward the [pause](#what-the-header-says).
- **Too large** is different: a revise round can't shrink work without cutting scope, so it skips revise rounds and doesn't count toward the pause. The project manager (PM) splits it into smaller issues, or allows it when it can't be split.
- **A reviewer whose checkout can't run the tests** says so instead of blaming the code. It gets the CI result and reviews again; if it happens a second time, a fresh reviewer takes over in a clean worktree.

### Automatic re-review and Retry

A stopped item's pull request often moves on: its builder resolves a conflict or fixes a last finding. When it has **new commits since its last review and green CI**, the factory sends it back to a fresh review by itself, up to **3 times per item** (never while paused). Approved, it merges as usual.

- **Retry** on a stopped item with an open pull request sends that pull request back to a fresh review with fresh revise rounds.
- **Rebuild** starts over from the first step; the old pull request is closed once the new one is open. Without an open pull request, Retry rebuilds.
- **Dismiss** marks failed work without a pull request as rejected.

### Infrastructure recovery

Failures outside the work's code never count toward the pause. The factory puts the item back by itself once the cause is gone, up to **3 times per item**:

- the builder's or reviewer's session died, or its provider dropped out: it goes back once a provider can work again;
- the builder's session is gone: a fresh builder picks the work up, or an integrator looks after its open pull request;
- **CI never started** on the head commit within 10 minutes: the factory starts it again (updating the branch, or pushing an empty commit).

### What needs you

The **Needs you** lane in the Factory view, and the header's **need you** count, list only what a person has to move:

- **Review and merge PR #n**: a pull request that passed every check and that the factory doesn't merge itself (auto-merge off, an untrusted author), or an **escalation** because it touches a protected area.
- **Retry: stopped after N review rounds**: stopped work whose pull request is still open.
- **Retry or dismiss: stopped without a pull request**: work that stopped in the last day without one.
- **Answer the agent's question**: an agent asked you something or wants an approval.

Your **inbox** also gets: pull requests ready for you, escalations, a paused loop (except for the budget), a regression, and work that's **stuck**: still conflicting after its one rebuild, refused by GitHub three times, or waiting on CI that can never run (GitHub Actions off, or no workflow).

**The factory handles by itself:** merge conflicts and rebases, pull requests behind the default branch, infrastructure failures, re-reviews after new commits, CI that never started, issues closed on GitHub, and changes that are too large (the PM's call).

## The two modes, side by side

| | Software factory | Dark factory |
|---|---|---|
| **Work comes from** | Issues by you and trusted authors | The same, plus the **scout** |
| **Who merges** | You, unless auto-merge is on | The same |
| **The PM** | Keeps up, asks you when unsure | Decides alone, records why |
| **Agents' questions** | Reach you | Answered at once |

### Software factory

You stay in the loop: work comes from issues you (and the people you trust) file, and with auto-merge off you merge every pull request. The PM hears about work that's ready, escalated or stuck. It retries stopped work, splits a change that's too large or allows it, and asks you when it's unsure. It lets in an untrusted author's issue only when you ask it to.

### Dark factory

The **scout** reviews the app against the vision and files the work itself. A round starts when fewer than **2** items wait and **6 hours** have passed since the last one (or right away with **Run scout now**):

1. **Plan.** The scout picks up to **2 review areas** for the round, out of eight: features, UI and UX, performance, code quality, test gaps, security, bugs and docs.
2. **Review.** Each area gets an **area reviewer**, a long-lived agent that keeps what it learned between rounds.
3. **File.** The scout files up to **3 issues** per round, already typed. They go down the pipelines like any trusted issue.

A round that runs over 3 hours is closed. No round starts at the open pull request limit, and the scout gets a free agent last.

**Nobody waits on you.** The PM and the factory's agents never stop to ask: a question is answered with "decide from the vision", and an approval is denied. Each judgement call is recorded with `factory_record_decision` and lands in your inbox as **Factory decided** (low priority) and in the daily digest.

**What still comes to you:**

- **Protected areas** from the vision (and **Protected paths**): a pull request that touches one is escalated and never merged automatically. To keep design decisions with you, protect their files.
- **Deploy and release files** are protected unless you turn on **Allow deploy and release changes**, and agents are told never to deploy or release.
- **Work from untrusted authors** runs only when you let it in, and is never merged automatically.
- **Flagged decisions** (a protected area, a missing or contradictory vision, anything irreversible outside the code) arrive as **Factory needs you**, at high priority.
- **Stuck work**, regressions and a paused loop.

## Controls

| Control | What it does |
|---|---|
| **Kill switch** (factory panel or Factory view) | Stops the project's loop and every factory session: builders, reviewers, the scout and its area reviewers. Builds without a pull request go back to the queue; work with one keeps its place. Nothing moves or merges until you turn it off. |
| **Global factory kill switch** (Settings → General) | The same for every project. |
| **Resume** | Shown while the loop is paused. Clears the pause and the failure count. There is no manual pause: use the kill switch. |
| **Check now** | Runs a pass right away instead of waiting up to 30 seconds. |
| **Run scout now** | Dark factory: starts a scout round now, skipping the interval and the backlog threshold. Not while a round runs, the loop is paused or over budget, at the open pull request limit, without a free agent, or with a kill switch on. |
| **Digest** | Today's digest, now, in your inbox. |
| **Settings** | The limits below, the merge checks, the agents and the scout. |

The limits that shape the loop:

| Setting | Default |
|---|---|
| Daily budget (USD and/or tokens) | Required. The loop pauses until the next day when it's spent |
| Agents at once | 2 |
| PRs open at most | Same as Agents at once |
| Auto-merges per day | 5 |
| Pause after failures | 3 in a row |
| Revise rounds | 2 |
| Watch main CI | 120 minutes |
| Scout: Review when fewer than / Every | 2 waiting / 6 hours |
| Scout: Review areas / Issues per round | 2 / 3 |

## Glossary

- **Item.** One piece of work: an issue on its way through a pipeline, with its pull request, checks and sessions.
- **Step.** Where an item is in its pipeline: Identify type, Reproduce, Analyze, Implement, Review, Merge.
- **Pass.** One run of the loop, every 30 seconds.
- **Area reviewer** (a **lens** in the code). A long-lived agent that reviews one area of the app for the scout.
- **Scout round.** One pass of the scout: plan, review, file issues.
- **Revise round.** The builder fixing what the reviewer or a failed check asked for, on the same branch.
- **Merge check.** One of the checks a pull request must pass before it merges: protected areas, size, CI, review, tests, test results, security, screenshots.
- **Merge queue.** Pull requests that passed every check, merged one at a time.
- **Escalated.** Touches a protected area, so only you merge it.
- **Stopped.** Work that ended without merging: not reproduced, declined, out of revise rounds or dismissed. Retry runs it again.
- **Stuck.** Work the factory can't settle by itself; it's in your inbox.
