import type { ChecklistProposal, ProjectChecklist } from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { useId } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useClient } from "@/lib/api";
import { ago } from "@/lib/format";
import { useSnapshot } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { ItemRow } from "./checklist-item";
import {
  approvalSummary,
  type DiffAddition,
  type DiffLine,
  decisionOutcome,
  decisionToast,
  diffLines,
  isApproved,
  proposalDetail,
  proposalLabel,
  stateLabel,
} from "./checklist-lifecycle";
import { localTime, STATUS_MARKER } from "./checklist-progress";

const SIGN_CLASS: Record<DiffLine["sign"], string> = {
  "+": "text-diff-add",
  "−": "text-diff-del",
  "~": "text-status-waiting",
};

/** A checklist diff as short signed lines; shared by the sidebar and the inbox card. */
export function DiffList({ lines, className }: { lines: DiffLine[]; className?: string }) {
  if (lines.length === 0) return null;
  return (
    <ul className={cn("flex flex-col gap-0.5 text-[12px] leading-snug", className)}>
      {lines.map((line, i) => (
        // Lines have no id of their own and never reorder within one diff.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <li key={i} className="flex gap-1.5">
          <span aria-hidden className={cn("w-2.5 shrink-0 text-center", SIGN_CLASS[line.sign])}>
            {line.sign}
          </span>
          <span className="sr-only">
            {line.sign === "+" ? "Add: " : line.sign === "−" ? "Remove: " : "Change: "}
          </span>
          <span className="flex min-w-0 flex-col">
            <span
              className={cn(
                "wrap-break-word text-foreground/90",
                line.sign === "−" && "text-muted-foreground line-through decoration-diff-del/50",
              )}
            >
              {line.text}
              {line.id && (
                <span
                  className="ml-1.5 font-mono text-3xs text-muted-foreground no-underline"
                  title={`Item ${line.id}`}
                >
                  {line.id}
                </span>
              )}
            </span>
            {line.addition && <AdditionMeta addition={line.addition} />}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What approving an addition applies: its starting status, ETA and owner ask. */
function AdditionMeta({ addition }: { addition: DiffAddition }) {
  const marker = STATUS_MARKER[addition.status];
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
      <span>
        Starts as <span className="font-mono">{marker.text}</span> {marker.label}
      </span>
      {addition.eta && (
        <span className="tabular-nums" title={`ETA ${new Date(addition.eta).toLocaleString()}`}>
          ETA {localTime(addition.eta)}
        </span>
      )}
      {addition.needsOwner && (
        <span className="min-w-0 wrap-break-word text-status-waiting">
          Needs you: {addition.needsOwner}
        </span>
      )}
    </span>
  );
}

/**
 * Approve / Reject for a checklist card: the inbox resolve call (resolved or dismissed). Without
 * its proposal in the snapshot (`ready` false) both stay disabled, so nobody decides blind.
 */
export function ChecklistDecision({
  inboxItemId,
  ready = true,
  approveLabel = "Approve",
}: {
  inboxItemId: string;
  ready?: boolean;
  approveLabel?: string;
}) {
  const client = useClient();
  const { refetch, isFetching } = useSnapshot();
  const decide = useMutation({
    mutationFn: async (approve: boolean) => {
      const startedAt = Date.now();
      const card = await client.resolveInbox(inboxItemId, {
        status: approve ? "resolved" : "dismissed",
      });
      return decisionToast(decisionOutcome(approve, card, startedAt));
    },
    onError: (e: Error) => toast.error("Couldn't record the decision", { description: e.message }),
    onSuccess: ({ tone, title, description }) =>
      (tone === "success" ? toast.success : toast.info)(title, { description }),
  });
  const disabled = decide.isPending || !ready;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button size="xs" disabled={disabled} onClick={() => decide.mutate(true)}>
        {approveLabel}
      </Button>
      <Button size="xs" variant="ghost" disabled={disabled} onClick={() => decide.mutate(false)}>
        Reject
      </Button>
      {!ready && (
        <Button
          size="xs"
          variant="link"
          className="px-1 text-muted-foreground"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          Reload to see this proposal
        </Button>
      )}
    </div>
  );
}

/** "Draft", or "Approved · locked" with a lock once the owner approved the list. */
export function StateChip({ checklist }: { checklist: ProjectChecklist }) {
  const approved = isApproved(checklist);
  return (
    <span
      title={
        approved
          ? `Approved${checklist.plan ? ` plan ${checklist.plan.sha}` : ""}${checklist.approvedAt ? ` ${ago(checklist.approvedAt)}` : ""}. Adding, removing or rewording items needs your approval.`
          : "Draft: the orchestrator can still change it"
      }
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-3xs font-medium",
        approved
          ? "bg-status-done/12 text-status-done"
          : "border border-sidebar-border text-muted-foreground",
      )}
    >
      {approved && <Lock aria-hidden className="size-2.5" />}
      {stateLabel(checklist)}
    </span>
  );
}

/** The switch that makes PM starts outside the approved plan wait for an expansion card. */
export function EnforceSwitch({ checklist }: { checklist: ProjectChecklist }) {
  const client = useClient();
  const id = useId();
  const enforce = checklist.enforce === true;
  const set = useMutation({
    mutationFn: (next: boolean) => client.setChecklistEnforce(checklist.projectId, next),
    onError: (e: Error) => toast.error("Couldn't change the setting", { description: e.message }),
  });
  return (
    <div
      className="ml-auto flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground"
      title={
        enforce
          ? "On: a PM start outside the approved plan waits for your approval"
          : "Off: PMs start work as usual"
      }
    >
      <label htmlFor={id} className="truncate">
        Enforce plan
      </label>
      <Switch
        id={id}
        size="sm"
        checked={enforce}
        disabled={set.isPending}
        onCheckedChange={(next) => set.mutate(next)}
      />
    </div>
  );
}

/**
 * The owner card waiting for this checklist: what it asks, why, the diff and the decision.
 * Keyed by the proposal's id, so a newer proposal never inherits the older one's controls.
 */
export function PendingProposal({ checklist }: { checklist: ProjectChecklist }) {
  const pending = checklist.pending;
  if (!pending) return null;
  return <ProposalBlock key={pending.id} checklist={checklist} pending={pending} />;
}

/**
 * What a proposal changes. Approving a draft locks the checklist as it is now, so an approval
 * shows the current items (status, ETA, owner asks) rather than the copy taken when it was
 * asked; `itemsBelow` says they are already listed under the proposal. An expansion shows its
 * diff.
 */
export function ProposalChanges({
  checklist,
  pending,
  itemsBelow = false,
  className,
}: {
  checklist: ProjectChecklist;
  pending: ChecklistProposal;
  itemsBelow?: boolean;
  className?: string;
}) {
  if (pending.plan) {
    const { plan } = pending;
    const lines = diffLines(pending.diff, undefined, checklist.items);
    const nextIds = new Set(plan.tasks.map(({ id }) => id));
    const previousOrder = checklist.plan?.tasks.filter(({ id }) => nextIds.has(id)) ?? [];
    const previousIds = new Set(previousOrder.map(({ id }) => id));
    const nextOrder = plan.tasks.filter(({ id }) => previousIds.has(id));
    const reordered = previousOrder.some(({ id }, index) => id !== nextOrder[index]?.id);
    return (
      <div className={className}>
        <p className="wrap-break-word text-2xs text-muted-foreground">
          Reviewed by reference {plan.reviewRef}
        </p>
        <p className="wrap-break-word font-mono text-3xs" title={plan.sha}>
          {plan.sha}
        </p>
        {checklist.plan && (
          <div className="mt-1">
            <p className="text-2xs font-medium">Changes to approved plan</p>
            <DiffList lines={lines} />
            {reordered && (
              <div className="mt-1 text-2xs">
                <p>Previous order — {previousOrder.map(({ text }) => text).join(" → ")}</p>
                <p>Revised order — {nextOrder.map(({ text }) => text).join(" → ")}</p>
              </div>
            )}
          </div>
        )}
        <details className="mt-1 text-xs" open={!checklist.plan}>
          <summary className="cursor-pointer font-medium">
            {checklist.plan ? "Revised plan" : "Reviewed plan"}
          </summary>
          <ol className="ml-4 mt-1 list-decimal space-y-0.5">
            {plan.tasks.map(({ id, text }) => (
              <li key={id} className="wrap-break-word">
                {text}
              </li>
            ))}
          </ol>
        </details>
      </div>
    );
  }
  if (pending.kind === "approve") {
    const summary = approvalSummary(checklist.items.length, itemsBelow);
    if (itemsBelow)
      return (
        <p className={cn("text-2xs leading-snug text-muted-foreground", className)}>{summary}</p>
      );
    return (
      <div className={className}>
        <p className="text-2xs leading-snug text-muted-foreground">{summary}</p>
        {checklist.items.length > 0 && (
          <ul className="mt-1 -mx-2 flex flex-col">
            {checklist.items.map((item) => (
              <ItemRow key={item.id} item={item} fresh={false} />
            ))}
          </ul>
        )}
      </div>
    );
  }
  return (
    <DiffList
      lines={diffLines(pending.diff, pending.additionMetadata, checklist.items)}
      className={className}
    />
  );
}

function ProposalBlock({
  checklist,
  pending,
}: {
  checklist: ProjectChecklist;
  pending: ChecklistProposal;
}) {
  const detail = proposalDetail(pending);
  const label = pending.plan
    ? checklist.plan
      ? "Approve plan changes"
      : "Approve reviewed plan"
    : proposalLabel(pending.kind);
  return (
    <section
      aria-label={label}
      className="mx-2 mt-2 rounded-lg border border-status-waiting/35 bg-status-waiting/6 px-2.5 py-2"
    >
      <p className="flex items-center gap-1.5 text-2xs font-medium text-status-waiting">
        <span aria-hidden className="size-1.5 rounded-full bg-status-waiting" />
        {label}
        <span className="font-normal text-muted-foreground">{ago(pending.requestedAt)}</span>
      </p>
      {detail && <p className="mt-1 text-2xs leading-snug text-muted-foreground">{detail}</p>}
      <ProposalChanges checklist={checklist} pending={pending} itemsBelow className="mt-1.5" />
      <div className="mt-2">
        <ChecklistDecision
          inboxItemId={pending.inboxItemId}
          approveLabel={pending.plan ? label : undefined}
        />
      </div>
    </section>
  );
}
