---
section: security
---

- **The docs pipeline skips the review only for documentation.** A docs work item merged without the independent review whenever its pull request had no code, so changes to `package.json`, lock files, CI workflows or `tsconfig`, or deleted tests, could merge on CI alone with auto-merge on. Now the review is skipped only when every file is prose (`.md`, `.txt`, `.rst`) or a raster image, with renamed files checked under their old path too. Anything else is reviewed like any other change: config, manifests, lock files, workflows, tests, the instructions coding agents load (`CLAUDE.md`, `AGENTS.md`, dot-folders such as `.claude/` or `.github/`) and code.
- **Fast merges re-test every `package.json` and lock file.** A workspace package's `package.json` and any `*.lock` file now always re-test against main before a fast merge, as the root `package.json` already did.
