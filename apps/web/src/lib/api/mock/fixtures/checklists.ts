import type { ChecklistItem, ProjectChecklist } from "@codeden/contracts";
import { ago } from "./helpers";

function item(id: string, text: string, status: ChecklistItem["status"], m: number): ChecklistItem {
  return { id, text, status, updatedAt: ago(m) };
}

/** Sample orchestrator checklists for two projects, so the checklist sidebar has content. */
export const checklists: ProjectChecklist[] = [
  {
    projectId: "p-storefront",
    items: [
      item("checkout", "Rebuild the checkout summary with line-item discounts", "done", 95),
      item("search", "Search results: keep filters in the URL", "done", 60),
      item("a11y", "Fix focus order in the cart drawer", "doing", 12),
      item("tests", "Tests for the new checkout flow", "doing", 4),
      item("copy", "Review empty-cart copy with design", "todo", 120),
      item("deploy", "Preview deploy for QA", "blocked", 30),
    ],
    changes: [
      { itemId: "tests", text: "Tests for the new checkout flow", from: "todo", to: "doing" },
      { itemId: "deploy", text: "Preview deploy for QA", from: null, to: "blocked" },
    ],
    updatedAt: ago(4),
  },
  {
    projectId: "p-billing",
    items: [
      item("webhooks", "Retry failed Stripe webhooks with backoff", "done", 240),
      item("export", "CSV export of invoices", "doing", 25),
      item("audit", "Audit log for refunds", "todo", 300),
    ],
    changes: [
      {
        itemId: "webhooks",
        text: "Retry failed Stripe webhooks with backoff",
        from: "doing",
        to: "done",
      },
    ],
    updatedAt: ago(25),
  },
];
