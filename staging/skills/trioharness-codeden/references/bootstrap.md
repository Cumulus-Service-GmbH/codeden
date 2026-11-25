# Repository bootstrap: stack, proof commands and delivery

Loaded on the first task in a repository, for a new repository, and whenever AGENTS.md lacks a "Stack and delivery", "High-risk paths" or "Proof commands" section. Binding when triggered.

Write nothing from assumption. Every line you add to AGENTS.md is either read from a file in the repo, observed from a command you ran, or confirmed by the user.

## 0. Repository shape before anything else
Run `node "<skill>/scripts/repo-shape.mjs" --repo <repo> --remote origin --want main`. Every candidate is based on `origin/<default>`, so a repository with no default branch, or whose remote default is a task branch (`bambooed/*`, `trio/*`, `harnessloop20260921`), is bootstrapped wrong and will keep failing gate 1.
- Exit 0 → record the default branch in the Repository shape section and continue.
- `task-shaped-default` / `no-default-branch` → the repair is `repo-shape.mjs --apply` (fetches the source branch from the remote, creates `main` from `FETCH_HEAD`, pushes it as a new ref, sets the local remote head, sets the remote default via `gh --repo <remote URL>`; it never uses local HEAD and deletes nothing; rerunning resumes where it stopped). It runs unattended only when AGENTS.md carries the exact standing-authorization line from `templates/repo/AGENTS.md`. On a fresh repository, that line is part of what the user confirms in step 7, so show the planned commands in the same confirmation and apply them once the user agrees. If the push is refused, report the hook's reason and stop — never `--no-verify`.
- `SHAPE_PARTIAL` → `main` exists and is pushed, but the remote default needs one setting changed by hand (no `gh`, no permission, or a non-GitHub host). Record it, name the setting, continue.
- `empty-repo` / `no-remote` / `no-remote-source` / `remote-unreachable` → never automatic: ask for an initial commit and a remote, or proceed under gate 1's local-only provenance rule.
Write the **Repository shape** section (default branch, the standing-authorization line, the no-auto-fix note) into AGENTS.md along with the rest in step 7.

## 1. Detect the stack from manifests
Read what exists, and record versions where a file states them:
- .NET: `*.sln`, `*.csproj`, `global.json`, `Directory.Build.props`; a DbContext or `Migrations/` folder means the EF check applies.
- Node: `package.json` (its real `scripts`), the lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`) which decides the package manager, and the test runner in devDependencies (vitest, jest, playwright).
- Python: `pyproject.toml`, `requirements*.txt`, `tox.ini`, `pytest.ini`.
- Go: `go.mod`. Rust: `Cargo.toml`. JVM: `pom.xml`, `build.gradle(.kts)`. PHP: `composer.json`. Ruby: `Gemfile`.
- Containers and infrastructure: `Dockerfile*`, `docker-compose*`, `infra/` (Bicep, Terraform), Helm charts, `deployment/`.
- CI configuration (`.github/workflows`, Azure Pipelines) is read **only as a source of facts** — image names, registries, app names, build arguments. Never run, dispatch or edit it. Any value in it that looks like a credential is a finding (`OUT_OF_SCOPE_RISK`), never copied.
Monorepo: record each buildable project separately (path + its own commands) rather than one repo-wide command.

## 2. Verify every command before writing it
For each candidate command (full build, full test, focused test, lint, typecheck), run it once in the task worktree through `run-lock.mjs run -- <command>` with its own results and temp directory. Only commands that exit 0 are written plainly; a command that fails or cannot run here is written as `unverified: <reason>` so the next run knows not to trust it. Never invent a command that is not in the repo's manifests or scripts.

Always record a **focused-test template** so lean and trivial tiers do not run the whole suite:
`dotnet test <project> --filter FullyQualifiedName~<name>` · `npx vitest run <path>` · `npx jest <path>` · `pytest <path>::<test>` · `go test ./<pkg>/...` · `cargo test <name>` · `mvn -Dtest=<name> test`.

## 3. Record app type and delivery
For each deployable unit: what it is (Azure Container App, App Service, Static Web App, Function App, Kubernetes, VM, npm package, desktop app, none), where it runs, and how it is delivered today. Discover with read-only commands that return **names only** (`az containerapp list --query '[].{name:name,rg:resourceGroup}' -o table`, `az webapp list --query '[].{name:name,rg:resourceGroup}' -o table`, `az acr list --query '[].name' -o tsv`, `kubectl config current-context`) plus the repo's own deployment files. Never run a bare `az … show`/`list` whose output carries environment values, and never paste such output into chat, the ledger or a packet.
- Supported by `deploy.mjs`: Container Apps and App Services → offer to create `.trioharness/deploy.json` (user confirms every target).
- Anything else → write "delivery: <method>, not automated by the harness; the user deploys" and stop there. Never improvise a deploy, and never use CI dispatch.

## 4. Find the commit-SHA endpoint
Locate the health, version or build-info endpoint that reports the running commit (search for `BUILD_REVISION`, `SourceRevisionId`, `GIT_SHA`, `/health`, `/version`, `/build-info`) and record its URL and shape (`shaField` dot path for JSON, `"."` for a plain-text body). If none exists, record "none yet" and propose adding one as its own task; without it, deploy verification cannot pass.

## 4b. Declare the running environments (read-only)
For every environment that runs this repo's code (QA, production, staging) record its name and the public health or version URL with the `shaField` of the commit SHA (from step 4). Write them to `.trioharness/environments.json` (`templates/repo/environments.json`): names and public URLs only, never a secret, never a URL with credentials (the reader refuses both). It grants no deploy rights; `deploy.json` stays a separate decision. `running-ref.mjs check` (gate 0b) then compares each environment with the live default branch at the start of every run. An environment whose app reports no commit SHA is written with a note and stays `unverified`; adding a version endpoint is its own task. Show the file to the user with the rest in step 8; the file is high-risk (`.trioharness/`).

## 5. Record shared resources
Fixed ports, local databases, emulators, fixed log paths, or anything two runs would collide on: give each a lock name for `run-lock.mjs run --name <resource>`, and list them under Proof commands.

## 6. Secrets section
Collect the secret NAMES the repo will need — the Jev key, every token `deploy.json` targets need, anything the proof commands read from the environment, appsettings and connection strings, test-account logins — and write them under a **Secrets** section in AGENTS.md (name and purpose only, bullets like `- NAME — purpose`). Then declare them: `node "<skill>/scripts/secrets.mjs" import-names --repo <repo>` writes `.trioharness/secrets.json` (names and rules only; adjust `env`, `scopes`, `delegate` and `store` with `declare`; a production secret is never `worker`, and a value that already lives in Azure Key Vault is declared with `--keyvault vault/secret`). Run `secrets.mjs status --repo <repo>`: it lists what is set and what is not. If the repo has a `.env` with values, `secrets.mjs migrate --repo <repo>` moves them into the Keychain (`--clear` blanks them in the file afterwards, only when the user agrees). For the rest, ask once, in the same confirmation as step 7, with the `secretneeded` card (`secrets.mjs card`); on "Set now" run `secrets.mjs set --name <NAME>` for each — the masked dialog opens on the user's screen and no value touches chat. If a `.env` is tracked, stop: the user untracks it first. The manifest is committed in the bootstrap pull request.

## 7. Handover section
Every repo's AGENTS.md carries the "Handover at the round limit" section from `templates/repo/AGENTS.md`, unchanged apart from the standing-authorization line, which the user answers once. Add it whenever it is missing.

## 8. Write and confirm
Add to AGENTS.md: the **Running environments and a clean end state** and **UI work** sections from the template, the **Repository shape** section from step 0, the **Secrets** section from step 6, a **Stack and delivery** section (stack and versions, projects, app type per unit, delivery method, SHA endpoint), the verified **Proof commands** (full build, full test, focused-test template, lint/typecheck, EF check when a DbContext exists, lock names), and the proposed **High-risk paths**. Show the user the proposed Stack/delivery and High-risk sections and get one confirmation before committing. The learning step keeps these current: replace a line when a command changes, never append a second version of it.

## 9. Agent knowledge (offer once)
Offer the user the repo knowledge base (`docs/agent-knowledge/`, see `references/questions-and-knowledge.md`). Only on a yes: `node "<skill>/scripts/knowledge.mjs" init --repo .`, include the two short sections from `templates/repo/AGENTS.md` ("Questions to me", "Agent knowledge"), and commit them as part of the bootstrap diff. On a no, record the decision in the ledger and do not ask again.

## 10. New repository: create it private and set up the GitHub side (only when the repo does not exist yet)
Skip this step for a repository that already has a remote. For a new project:
1. Confirm with the user in ONE card: the repository name, the reference repo to copy from (an existing repo of the same owner whose settings and rulesets are the standard; default: the repo the user names, else ask), and a one-line description.
2. `node "<skill>/scripts/github-setup.mjs" plan --repo <owner>/<name> --reference <owner>/<reference>` then, after the answer, `apply … --confirm`. It creates the repository **private** (it refuses a public one and never touches an existing public repo), pushes the local source when `--source` is given, copies merge settings and every ruleset from the reference (the merge-approval rule included), and turns on vulnerability alerts, automated security fixes and secret scanning with push protection where the plan allows. It never deletes anything. Whatever GitHub refuses is reported, not worked around.
3. Put the files that belong in the repo into the bootstrap pull request: `templates/repo/github/pull_request_template.md` as `.github/pull_request_template.md` (with its **Package and config check** section), `templates/repo/github/workflows/ci.yml` as `.github/workflows/ci.yml` (replace the build-test placeholder with the verified proof commands from step 2, and copy the `secret-scan` job from the reference repo's workflow), plus the sections of `templates/repo/AGENTS.md`. The skeleton fails until the build-test step is replaced, so the repo cannot look green without checks. Required status checks are named in the ruleset copied from the reference: make the job names match.
4. Send the **credential items** from the report to the CodeDen orchestrator (not Moshe) in one message: add the repo to the approver token's repository list (a fine-grained token cannot be edited through the API) and add it to the "Cumulus Agents" app installation if the script could not. Check Settings → Rules yourself. Nothing else needs anyone outside the session; the PM or its session merges the bootstrap pull request per SKILL.md gate 9.
5. The first push of the default branch happens before the ruleset blocks it; every later change is a pull request. Record the owner, the reference repo and the date in the ledger.

## 10b. Existing repository: bring its GitHub side up to the baseline (only when the task prompt authorizes it and names the repo)
`node "<skill>/scripts/github-setup.mjs" audit --repo <owner>/<name> --reference <owner>/<healthy repo>` (read-only) lists every gap and its fix; `converge … --confirm` fills in the missing merge settings, rulesets, alerts and secret scanning without creating or deleting anything. Missing repo files go in the bootstrap pull request. For verified merge (`merge-verify.mjs install`, the proof PR, `github-setup.mjs verified-merge`) follow `references/seal-run.md`.

## 11. Databases and standing rules
- If the app uses databases or servers that only the Azure network can reach, add the **Databases and servers (db-ops)** section from `templates/repo/AGENTS.md` and read `references/db-ops.md`. Names only, never a connection string.
- Add the **Standing orders and cards** section from the template. Standing orders already recorded for the user (`standing-orders.mjs list`) apply to this repo from the first run; propose new ones only from the user's own words (`references/questions-and-knowledge.md` §4).
