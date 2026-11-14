---
section: added
---

- **See what each factory item cost, and cap it.** Every work item now shows what it cost so far on its Factory view card, its side sheet and its item page, for example "≈ $12.40 · 4.1M tokens". So you can tell that one feature took four revise rounds and $12 while the rest cost under $1.
  - The figure counts every session that worked on the item: builders, reviewers, integrators and earlier attempts, over all time. It comes from the same ledger as the usage reports, with the same labels: "≈" for estimates, "API-equivalent" for a subscription login, and "Not priced" when no model had a price.
  - A new **Per-item cap** (USD and/or tokens, off by default) sits next to the daily budget in the factory settings. The daily budget only stops new work, so the cap is what keeps one item from spending the day's budget on its own. An item that reaches it has its running sessions stopped and waits for you as stuck ("Spend cap reached: $5.10 of $5.00 for this item"), in your inbox or, in a dark factory, as a recorded decision. It doesn't count toward the failure pause. While it waits, the factory starts no rebase, integrator or re-review for it. **Retry** gives it a fresh allowance, while its cost still shows everything it spent. Cards turn amber from 80% of the cap.
  - API: `FactoryLimits.itemBudget`, `FactoryWorkItem.cost` and `FactoryItemResponse.cost` (`FactoryItemCost`), and `FactoryItem.sessionIds` and `itemBudgetSince`.
