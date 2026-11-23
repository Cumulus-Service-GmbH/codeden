import { type DecisionCard, OwnerApprovalWords } from "@codeden/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useClient } from "@/lib/api";

import { decisionCardsKey, useSnapshot } from "@/lib/queries";

function DecisionCardRow({ card }: { card: DecisionCard }) {
  const client = useClient();
  const queries = useQueryClient();
  const ownerWordsId = useId();
  const ownerWordsHelpId = `${ownerWordsId}-help`;
  const [ownerWords, setOwnerWords] = useState("");
  const mergeVerify = card.request.kind === "github" && card.request.target.kind === "merge_verify";
  const canApprove =
    !mergeVerify || (!!ownerWords.trim() && OwnerApprovalWords.safeParse(ownerWords).success);
  const approval = useMutation({
    mutationFn: () =>
      client.github.approveDecisionCard(card.id, mergeVerify ? { ownerWords } : undefined),
    onSuccess: () => queries.invalidateQueries({ queryKey: decisionCardsKey }),
  });
  const { data: snapshot } = useSnapshot();
  const project =
    snapshot?.projects.find(({ id }) => id === card.projectId)?.name ?? card.projectId;
  const request = card.request;
  const steps =
    request.kind === "plan"
      ? request.steps.map((step) => `${step.action}\n${JSON.stringify(step.args, null, 2)}`)
      : [];
  const target = request.kind === "github" ? request.target : null;
  return (
    <article className="space-y-2 rounded-md border border-border bg-card p-3 text-sm">
      <h3 className="font-medium">
        {target?.kind === "merge_verify"
          ? "Approve pull request"
          : target?.kind === "environment_release"
            ? "Approve environment release"
            : "Approve plan"}
      </h3>
      <p className="break-words text-xs text-muted-foreground">{project}</p>
      {target ? (
        <div className="text-xs text-muted-foreground">
          <p className="break-words">{target.repository}</p>
          {target.kind === "merge_verify" ? (
            <>
              <p>Pull request #{target.pullNumber}</p>
              <code className="break-all">{target.headSha}</code>
            </>
          ) : (
            <>
              <p>Workflow run {target.runId}</p>
              <p>Environment IDs {target.environmentIds.join(", ")}</p>
            </>
          )}
        </div>
      ) : (
        <ol className="list-decimal space-y-2 pl-4 text-xs">
          {steps.map((step, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: The position is fixed on the immutable plan.
            <li key={index} className="whitespace-pre-wrap break-all font-mono">
              {step}
            </li>
          ))}
        </ol>
      )}
      {mergeVerify && (
        <div className="space-y-1">
          <label htmlFor={ownerWordsId}>Approval message for the pull request</label>
          <Textarea
            id={ownerWordsId}
            aria-describedby={ownerWordsHelpId}
            required
            value={ownerWords}
            onChange={(event) => setOwnerWords(event.target.value)}
          />
          <p id={ownerWordsHelpId} className="text-xs text-muted-foreground">
            Use 1–200 characters. ASCII letters, digits, spaces and .,:;!?'()/- are allowed.
          </p>
        </div>
      )}
      {approval.error && (
        <p role="alert" className="text-xs text-destructive">
          {approval.error.message}
        </p>
      )}
      <Button
        size="sm"
        disabled={approval.isPending || !canApprove}
        onClick={() => approval.mutate()}
      >
        {approval.isPending ? "Recording approval…" : "Approve"}
      </Button>
    </article>
  );
}

export function useDecisionCards() {
  const client = useClient();
  return useQuery({
    queryKey: decisionCardsKey,
    queryFn: () => client.github.decisionCards(),
  });
}

export function DecisionCards({ cards }: { cards: DecisionCard[] }) {
  if (cards.length === 0) return null;
  return (
    <section aria-label="Approval cards" className="my-2 space-y-2">
      {cards.map((card) => (
        <DecisionCardRow key={card.id} card={card} />
      ))}
    </section>
  );
}
