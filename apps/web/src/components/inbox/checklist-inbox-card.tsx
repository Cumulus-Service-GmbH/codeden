import type { InboxItem } from "@codeden/contracts";
import { ChecklistDecision, ProposalChanges } from "@/components/checklist/checklist-approval";
import { checklistForCard, proposalDetail } from "@/components/checklist/checklist-lifecycle";
import { ago } from "@/lib/format";
import { useSnapshot } from "@/lib/queries";

/**
 * A `checklist_approval` card. While open it shows the reason of the checklist proposal it
 * belongs to and what it changes (an approval shows the checklist's current items, an
 * expansion its diff), then Approve / Reject; a closed card shows its body as is.
 */
export function ChecklistInboxCard({ item }: { item: InboxItem }) {
  const { data } = useSnapshot();
  const open = item.status === "open";
  const checklist = open ? checklistForCard(data?.checklists, item.id) : undefined;
  const pending = checklist?.pending;
  const detail = pending ? proposalDetail(pending) : null;
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <h3 className="text-[14px] font-medium">{item.title}</h3>
      {!open && item.body && (
        <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-muted-foreground">
          {item.body}
        </p>
      )}
      {detail && (
        <p className="mt-1 break-words text-[13px] leading-relaxed text-muted-foreground">
          {detail}
        </p>
      )}
      {checklist && pending && (
        <ProposalChanges checklist={checklist} pending={pending} className="mt-2 text-[13px]" />
      )}
      {open && !pending && (
        <p className="mt-1 text-[13px] text-muted-foreground">
          This proposal isn't loaded here yet, so it can't be decided from this card.
        </p>
      )}
      {open ? (
        <div className="mt-3">
          <ChecklistDecision
            key={pending?.id ?? item.id}
            inboxItemId={item.id}
            ready={pending !== undefined}
            approveLabel={
              pending?.plan
                ? checklist?.plan
                  ? "Approve plan changes"
                  : "Approve reviewed plan"
                : undefined
            }
          />
        </div>
      ) : (
        <p className="mt-2 text-2xs text-muted-foreground">
          {item.status === "resolved" ? "Approved" : "Rejected"}{" "}
          {item.resolvedAt ? ago(item.resolvedAt) : ""}
        </p>
      )}
    </div>
  );
}
