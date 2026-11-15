import { INBOX_BULK_MAX, type InboxItem } from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { CheckCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { type CodeDenClient, useClient } from "@/lib/api";
import { splitForDismiss } from "@/lib/inbox";

/** How long a bulk dismiss can be undone from its toast. */
export const UNDO_MS = 10_000;

/** How many of the items that stay the confirmation names. */
const NAMED = 5;

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const notices = (n: number) => count(n, "notice");

/** "3 items that wait on you stay" (or "1 item that waits on you stays"). */
function stayLine(n: number): string {
  return n === 1 ? "1 item that waits on you stays" : `${n} items that wait on you stay`;
}

/** Undo from the toast: reopens exactly what the dismiss closed (`POST /api/inbox/restore`). */
function undo(client: CodeDenClient, ids: string[], what: (n: number) => string) {
  client.restoreInbox(ids).then(
    (res) => toast.success(`Restored ${what(res.restored)}`),
    (e: Error) => toast.error("Couldn't undo the dismiss", { description: e.message }),
  );
}

/**
 * Dismiss several items in one request (§11.1), then a toast with **Undo** for
 * {@link UNDO_MS}. Undo needs nothing from the component, so it still works once the dismissed
 * items (and this button with them) are gone. `what` names the items: "6 notices".
 */
export function useBulkDismiss(what: (n: number) => string) {
  const client = useClient();
  return useMutation({
    mutationFn: (items: InboxItem[]) =>
      client.dismissInbox(items.slice(0, INBOX_BULK_MAX).map((i) => i.id)),
    onError: (e: Error) => toast.error("Couldn't dismiss them", { description: e.message }),
    onSuccess: (res) => {
      if (res.dismissed === 0) {
        toast.warning("Nothing was dismissed", {
          description: res.kept > 0 ? `${stayLine(res.kept)}.` : undefined,
        });
        return;
      }
      toast.success(`Dismissed ${what(res.dismissed)}`, {
        description: res.kept > 0 ? `${stayLine(res.kept)}.` : undefined,
        action: { label: "Undo", onClick: () => undo(client, res.ids, what) },
        duration: UNDO_MS,
      });
    },
  });
}

/** An item that stays, as the confirmation names it. */
export interface StayingItem {
  id: string;
  title: string;
}

/**
 * The inbox header's **Dismiss N** (§11.1): dismisses the notices in the current view (`items`,
 * what the active tab lists) after a short confirmation that names what stays. Items that wait
 * on the user stay, with the view's conflicts (`alsoStaying`). Hidden when nothing would go.
 */
export function DismissView({
  items,
  alsoStaying = [],
}: {
  items: InboxItem[];
  alsoStaying?: StayingItem[];
}) {
  const [confirming, setConfirming] = useState(false);
  const bulk = useBulkDismiss(notices);
  const { dismiss, stay } = splitForDismiss(items);
  const staying: StayingItem[] = [...alsoStaying, ...stay];
  const n = dismiss.length;
  if (n === 0) return null;
  const named = staying.slice(0, NAMED);
  const more = staying.length - named.length;

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="text-muted-foreground"
        title={`Dismiss the ${notices(n)} in this view`}
        onClick={() => setConfirming(true)}
        disabled={bulk.isPending}
      >
        <CheckCheck /> Dismiss {n}
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Dismiss {notices(n)}?</AlertDialogTitle>
            <AlertDialogDescription>
              {notices(n)} will be dismissed
              {staying.length > 0 ? `; ${stayLine(staying.length)}.` : "."} You can undo it for a
              few seconds.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {named.length > 0 && (
            <div className="min-w-0 text-[13px]" data-testid="dismiss-staying">
              <div className="mb-1.5 text-2xs text-muted-foreground">Staying</div>
              <ul className="space-y-1">
                {named.map((s) => (
                  <li key={s.id} className="truncate">
                    {s.title}
                  </li>
                ))}
              </ul>
              {more > 0 && <div className="mt-1 text-muted-foreground">and {more} more</div>}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => bulk.mutate(dismiss)}>Dismiss {n}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
