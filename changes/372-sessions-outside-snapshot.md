---
section: fixed
---

- **Older archived sessions keep their features in the inbox, the Diff panel and the Factory view.** Since the snapshot carries only recently archived sessions, three views lost features for older ones without an error. They now look those sessions up from the server. A failed run's Retry is off again while its provider can't run, and it offers "Continue on another provider", also from the error toast. The Diff panel's "Compare with…" lists a fork's, hand-off's or review's archived source. The Factory view's cards and pixel-mode agents show their provider and last activity again. Each view fetches all the sessions it's missing in one request, and only once.
