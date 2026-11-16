---
section: fixed
---

- **The integrator that takes over a factory pull request no longer starts on a signed-out or usage-limited provider while another one is free.** When the session that wrote a PR was gone and the PR had merge conflicts, or CI never started on it, the integrator always started on the default provider and ignored the factory's provider back-offs. The PR then sat, or its integrator failed. The integrator's provider and model are now chosen like the item's builder's, with the same fallback. While no provider is available it waits ("Waiting: no integration provider available …") without holding an agent slot, and starts once a provider is free.
- **An integrator whose start never reached its provider no longer stays in charge of the PR without its brief.** After the item failed outside its code, the recovery kept such an integrator as the PR's agent. The next conflict or CI kick then sent it only a rebase or "re-run CI" request, on the provider that had refused it. It is now let go and archived. The provider that refused it is backed off, and the next conflict or CI kick starts a fresh integrator, with its full brief, on an available provider.
