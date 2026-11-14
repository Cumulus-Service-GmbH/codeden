---
section: security
---

- **A pull request's file names can't fake diff lines.** The PR view now quotes file names in its diffs the way git does, so a name with a newline, tab, quote or other special character stays a name. If a file's diff still can't be shown, that file says "Couldn't render this file's diff" with a link to GitHub, and the rest of the pull request keeps working.
