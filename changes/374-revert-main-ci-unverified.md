---
section: fixed
---

- **A revert whose CI on the default branch never says green no longer leaves the factory paused silently.** If CI doesn't report on the revert's merge commit in time (no run after 10 minutes, or still running at the watch limit), the factory checks once more. If there's still nothing, the regression's inbox item becomes "main is red or unverified after revert #N: CI didn't report", and a late green run still resumes the loop. If CI on the revert's merge commit is red, that same inbox item says main is still red after the revert; before, you got a second, generic "loop paused" item. When you resume the loop, the reverted work goes back to its builder once, as it would after a green run.
