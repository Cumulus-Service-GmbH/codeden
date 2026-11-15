---
section: fixed
---

- **The factory keeps lessons that protect the `CODEDEN_*` filters.** A reviewer's lesson such as "Don't remove the CODEDEN_* filter from vitest.config.ts" was mistaken for the retired "unset CODEDEN_* before running tests" advice, so it was never recorded and never reached builders or reviewers. Only advice to clear the variables is dropped now. Lessons that warn against clearing them ("don't remove", "never strip", "no need to unset") or that are about the filter itself are kept.
