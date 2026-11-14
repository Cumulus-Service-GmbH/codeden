---
section: added
---

- **Faster merge queue: merge on the pull request's own CI when nothing it changed moved.** With auto-merge on, a queued pull request that is behind the default branch no longer always waits for a second CI run. When the commits it is missing touch none of its files, it merges on its own green CI and GitHub's merge commit combines them. It is still brought up to date and re-tested first when:
  - the new commits touch its files;
  - either side changed a dependency, CI, TypeScript or build config, migration or shared barrel file;
  - GitHub's merge state isn't clean;
  - branch protection requires up-to-date branches (you're told once);
  - CI on the default branch is red.
- **Merge policy in the factory's Limits.** Choose **Fast** (the default) or **Strict**, which always re-tests. Queue notes say which path each pull request took and why. The Factory view's figures show the fast and re-tested merges over 7 days, and how many fast merges were reverted.
- **Merges that land on top of an unverified merge are judged in order.** When CI on the default branch breaks, a merge that landed while an earlier merge's CI was still running waits for that merge's verdict. If the earlier merge is the one reverted, the later one isn't reverted with it.
