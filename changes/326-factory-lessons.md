---
section: added
---

- **The factory learns from its reviews.** Reviewers can now add up to three general lessons to a verdict: rules for the whole repository rather than findings about one pull request, such as "every user-facing change adds a changelog fragment" or "run the focused test file before the whole suite". The factory keeps them per project. Every new builder and reviewer gets the 20 most recent in its brief, so the same finding stops costing a revise round on item after item.
  - The factory panel lists the lessons under **Lessons**, each with the pull request it came from and how often reviewers recorded it. **Forget** removes a lesson from the briefs for good, and the factory never learns it again. The item page shows the lessons its verdict recorded.
  - A lesson recorded again (ignoring case, spacing and a final period) counts up instead of appearing twice. Lessons are cut to 300 characters and secrets in them are masked. A verdict is never rejected because of its lessons.
  - Lessons only come from reviews of trusted work. Work let in from an untrusted author teaches the factory nothing, because a stranger's text steered that review.
  - **Learn from reviews** in the factory settings (on by default) turns it off: reviewers aren't asked for lessons, none are kept, and briefs carry none.
  - API: `ReviewVerdict.lessons`, `FactoryTuning.learnFromReviews`, `FactoryStatus.lessons`, the `factory.lesson.updated` event, and `DELETE /api/projects/:id/factory/lessons/:lessonId` to forget a lesson (404 `lesson_not_found`).
