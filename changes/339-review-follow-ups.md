---
section: fixed
---

- **An approval with a non-blocking note no longer loops through revise rounds.** A reviewer that approved with a note in its security concerns failed the security check, so the builder was asked to fix what the reviewer had said could wait, and the same commit was reviewed again until the revise rounds ran out. Security concerns now always block the merge, and `factory_submit_review` refuses an `approve` that lists one: the reviewer asks for changes, or moves the item to the new **follow-ups**.
  - **Follow-ups** are the review's non-blocking findings (up to 5, each a title with an optional severity and area). They never fail a merge check or start a revise round.
  - Once the pull request merges, the dark factory files each follow-up as an issue, labelled `codeden-factory` and `codeden-follow-up` and linked to the pull request, and takes it on like any other issue. In the software factory they're listed on the item page with **File issue**. A follow-up whose title matches an open issue is linked to that issue instead, and none is filed twice.
  - API: `ReviewVerdict.followUps`, `FactoryItem.followUps` (each with the `issue` that tracks it) and `POST /api/projects/:id/factory/items/:itemId/follow-ups/file` with `{ index }`.
