---
section: changed
---

- **A dark factory's review follow-ups wait for the scout instead of becoming issues at once.** When a pull request merges in a dark factory with scheduled scout rounds on, its low and medium follow-ups are held as findings for the scout. In its next round the scout weighs them with its area reviewers' findings and files at most **Issues per round** in total, so follow-ups no longer add builds, reviews and pull requests faster than the scout's limit. It may file from them alone, without planning review areas.
  - A `high`-severity follow-up, or one in the `security` area, is still filed at once and doesn't count toward the round's limit.
  - The held list stays short. A follow-up whose title matches an open issue is linked to it, and one matching a follow-up already held isn't held twice. At most 50 are kept, with the oldest low-severity ones dropped first, and one the scout hasn't filed after 14 days is dropped.
  - The scout's card on the factory panel and in the Factory view shows **N held follow-ups**. Its list shows each with its source pull request and severity, plus **File now** and **Dismiss**. The item page marks a follow-up "held for the scout", or why it left the list, and the daily digest says how many were held, filed, dropped and dismissed.
  - The software factory is unchanged: follow-ups stay on the item page with **File issue**. A dark factory with scheduled rounds off (**Review when fewer than** 0) files every follow-up at once, as before. Issues already filed for follow-ups are left alone.
  - API: `POST /api/projects/:id/factory/items/:itemId/follow-ups/dismiss` (`{ index }`) dismisses a held follow-up, and `follow-ups/file` is **File now**. The factory status lists them in `scout.heldFollowUps`, and the digest counts them in `followUps`.
