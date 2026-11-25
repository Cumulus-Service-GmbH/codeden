import type { ProjectChecklist } from "@codeden/contracts";
import { badRequest } from "../errors";
import { sameChecklistPurpose } from "./checklist-service";

export function checklistIsEnforced(
  checklist: ProjectChecklist | undefined,
): checklist is ProjectChecklist & { state: "approved"; enforce: true } {
  return checklist?.state === "approved" && checklist.enforce === true;
}

export function checklistStartItem(
  checklist: ProjectChecklist | undefined,
  purpose: string,
  itemId?: string,
  matchPurpose = false,
) {
  if (checklist?.pending?.plan && !checklist.plan) {
    throw badRequest("The reviewed plan is awaiting owner approval.", "plan_approval_pending");
  }
  const item = itemId
    ? checklist?.items.find((entry) => entry.id === itemId)
    : matchPurpose
      ? checklist?.items.find(
          (entry) =>
            entry.status !== "done" &&
            entry.startPurpose !== undefined &&
            sameChecklistPurpose(entry.startPurpose, purpose),
        )
      : undefined;
  if (!checklistIsEnforced(checklist)) return item;
  if (!item) {
    if (itemId) {
      throw badRequest(`Unknown approved checklistItemId: ${itemId}.`, "checklist_item_unknown");
    }
    if (checklist.plan) {
      throw badRequest(
        "Work outside the pinned plan requires a reviewed revision.",
        "outside_pinned_plan",
      );
    }
    return;
  }
  if (item.status === "done") {
    throw badRequest(
      `Checklist item ${item.id} is done; ask the orchestrator for an expansion card.`,
      "checklist_item_done",
    );
  }
  if (item.startPurpose !== undefined && !sameChecklistPurpose(item.startPurpose, purpose)) {
    throw badRequest(
      `Checklist item ${item.id} was approved for "${item.startPurpose}". Use the same purpose to start this item.`,
      "checklist_purpose_mismatch",
    );
  }
  return item;
}
