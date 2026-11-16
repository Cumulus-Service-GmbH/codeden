---
section: fixed
---

- **The agent writing an automatic revert no longer gets stuck on a signed-out or usage-limited provider while another one is free.** It always started on the default provider, ignoring the factory's provider back-offs, so a signed-out, rate-limited or outdated provider took all three of the revert's starts, failed it as stuck, and left main red with the loop paused until someone stepped in. The revert's provider and model are now chosen like a bug builder's, with the same fallback: a provider the factory backed off is skipped for another available one, including the provider that just refused the revert's session. While no provider is available, the revert waits in the queue ("Waiting: no revert provider available …") without using up a start, and starts as soon as one is free.
