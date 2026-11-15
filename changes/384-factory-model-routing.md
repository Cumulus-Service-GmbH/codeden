---
section: added
---

- **Choose the model for docs builds and for the scout.** The factory no longer runs every agent on the one builder model. Simple work can go to a cheaper model while features and bugs stay on the stronger one, and the scorecard shows how each does.
  - **Docs builder** (Settings > Agents): the provider and model for builds of docs items. **Same as builders** (the default) keeps them on the builder's provider and model, as before. Feature and bug builds always use the builder's.
  - **Scout provider and model** (Settings > The scout, dark factory): the scout and its area reviewers, long-lived agents that read a lot of code each round and are often the factory's biggest token users. **Automatic** (the default) keeps the project's provider, as before. A scout or area reviewer already running on another provider or model is replaced by a fresh one at its next round, and the old session is archived.
  - When the provider you chose is unavailable (not signed in, at its usage limit, too old to run), these agents start on another available provider with its default model, as builders do. With no provider available, a docs build waits and no new scout session starts.
  - API: `FactoryTuning` gains `docsBuilderProvider` and `docsBuilderModel` (`null`: same as builders), and `scoutProvider` (`auto`) and `scoutModel` (`null`).
