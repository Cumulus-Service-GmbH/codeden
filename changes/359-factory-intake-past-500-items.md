---
section: fixed
---

- **The factory no longer takes an open issue in twice once a project has more than 500 work items.** Intake only checked the newest 500 items, so an open issue whose item had dropped out of them looked new and got a second work item. That happened to ignored issues from untrusted authors, failed or rejected items whose issue stayed open, and items that waited a long time in the backlog. Intake, recovery, closing replaced pull requests and the loop's other steps now see every item. Only the Factory view still lists the newest 500.
- **Factory ticks read the work items once.** Each tick used to re-read and re-parse the item list about 25 times, and every scout and PM factory call queued behind it. The tick's steps now share one read.
