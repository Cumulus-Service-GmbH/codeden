---
section: fixed
---

- **Failed factory sessions no longer pile up in the sidebar.** When a factory reviewer fails and the factory starts a fresh one, for example on another provider after a CLI that's too old, an expired sign-in or a usage limit, it archives the failed reviewer as soon as the replacement starts. When an item finishes, any of its sessions that failed are archived with the rest, wherever they worked. Archiving works as usual: the worktree is removed, unless it has uncommitted changes.
  - A failed session that is still the item's current builder or reviewer stays visible until someone retries or the factory recovers the item, because it needs attention. A reviewer that failed also stays until its replacement has started, while the item's note says why.
  - On the first start after the update, the factory archives the failed sessions that earlier versions left behind once their item had finished or a later session had replaced them. It does this once, so a session you restore afterwards stays.
  - The factory item page lists the item's **Earlier sessions** (replaced reviewers, earlier attempts), with their status and whether they're archived. Archived sessions are still one click away.
