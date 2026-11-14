---
section: fixed
---

- **Long sessions open fast and stay light.** Opening a session used to download its whole transcript, so long-lived PM, orchestrator and scout sessions sent megabytes on every open and grew with every turn. A transcript now opens at its latest 20 turns, and scrolling to the top (or the "N earlier turns" button there) loads the 20 before them, keeping your place. A search hit or link to an older message loads back to that message. The Factory view's quick PM chat fetches only the three turns it shows, and read-aloud only the latest few.
  - API: `GET /api/sessions/:id/snapshot` takes `turns` (the latest N root-thread turns, with their items and the subagent threads they started), `before` (the page before a turn) and `item` (reach back to an item's turn). `SessionSnapshot.earlierTurns` counts the root turns left out. Without `turns` it still returns the whole session.
