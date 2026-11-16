---
section: fixed
---

- **A red default branch no longer fails every factory pull request on top of it.** While CI on the default branch was red, every PR whose CI ran on top of it failed the same checks, and the factory treated that as the PR's own failure: its builder got revise round after revise round it could do nothing about, and then the item failed. A PR whose CI fails only checks that also fail on the default branch now waits for it ("CI on main is red (…); waiting for main to be green again"), with no revise round and no failure counted, and the merge queue passes over it so the fix can still merge. Once CI on the default branch is green, the factory updates the PR so CI runs on the fixed branch, and judges it on that run. A PR that fails a check the default branch passes gets its revise round as before. Work already failed this way in the last week goes back to verification by itself once the default branch is green.
