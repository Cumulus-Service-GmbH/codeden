---
section: fixed
---

- **Spec approval and spot-checks are easier to read and act on.** On a factory item's page, a spec waiting for approval now comes before **Approve spec** and **Request changes**: you read the analysis and the acceptance criteria first, then decide. The spec renders as formatted Markdown, in full, where it used to show raw syntax in a small scrolling box. The analysis outcome is in words ("Build it", "Out of scope", "Not reproduced"), where it used to show the raw value.
  - The inbox's **Open spot-checks** opens the project page scrolled to the Spot-checks list, open, with the first merge waiting for a look in view. It used to open at the top of the page, far above the list.
  - The PR view opened from a spot-check has **Looks good** and **Found a problem** in its footer, so you record what you found where you read the change. The dialog closes once it's recorded.
