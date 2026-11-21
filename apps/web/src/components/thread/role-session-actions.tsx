import type { Session } from "@codeden/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { Archive, MessageSquarePlus } from "lucide-react";
import { toast } from "sonner";
import { ArchivedSessionsList } from "@/components/project/lists";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { useClient } from "@/lib/api";
import { snapshotKey, useSnapshotData } from "@/lib/queries";
import { activeRoleSession } from "@/lib/snapshot-reducer";

export type RoleSessionDialog = "fresh" | "archives";

export function RoleSessionMenu({
  session,
  running,
  onOpen,
}: {
  session: Session;
  running: boolean;
  onOpen: (dialog: RoleSessionDialog) => void;
}) {
  const current = useSnapshotData(
    (snap) =>
      session.role !== "agent" &&
      activeRoleSession(snap, session.role, session.projectId)?.id === session.id,
    false,
  );
  const hasOpenQuestion = useSnapshotData(
    (snap) =>
      snap.inbox.some(
        (item) =>
          item.sessionId === session.id &&
          item.status === "open" &&
          (item.kind === "question" || item.kind === "approval"),
      ),
    false,
  );
  if (!current || session.archivedAt) return null;
  const blocked =
    session.status === "waiting" || hasOpenQuestion
      ? "Resolve the open question first."
      : running || ["created", "starting", "queued", "running"].includes(session.status)
        ? "Wait for the current work to finish."
        : null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={blocked !== null} onSelect={() => onOpen("fresh")}>
        <MessageSquarePlus />
        <span className="flex min-w-0 flex-col">
          Start fresh…
          {blocked && <span className="text-2xs text-muted-foreground">{blocked}</span>}
        </span>
      </DropdownMenuItem>
      {session.role === "orchestrator" && (
        <DropdownMenuItem onSelect={() => onOpen("archives")}>
          <Archive /> Archived conversations
        </DropdownMenuItem>
      )}
    </>
  );
}

export function RoleSessionDialogs({
  session,
  dialog,
  onClose,
}: {
  session: Session;
  dialog: RoleSessionDialog | null;
  onClose: () => void;
}) {
  const client = useClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const startFresh = useMutation({
    mutationFn: () => client.orchestration.startFresh(session.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: snapshotKey });
      onClose();
      if (router.state.location.pathname !== `/sessions/${encodeURIComponent(session.id)}`) return;
      if (session.role === "orchestrator") {
        void navigate({ to: "/" });
      } else if (session.projectId) {
        void navigate({ to: "/projects/$projectId/pm", params: { projectId: session.projectId } });
      }
    },
    onError: (error) => toast.error("Couldn't start fresh", { description: error.message }),
  });
  const history =
    session.role === "orchestrator" ? "conversation history" : "the project's Archived list";
  return (
    <>
      <AlertDialog
        open={dialog === "fresh"}
        onOpenChange={(open) => {
          if (!open && !startFresh.isPending) onClose();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start fresh?</AlertDialogTitle>
            <AlertDialogDescription>
              The current conversation will move to {history}. The new conversation will use the
              provider and model in Settings.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={startFresh.isPending}>Cancel</AlertDialogCancel>
            <Button disabled={startFresh.isPending} onClick={() => startFresh.mutate()}>
              {startFresh.isPending ? "Starting…" : "Start fresh"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={dialog === "archives"} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Archived conversations</DialogTitle>
            <DialogDescription>Past conversations with the orchestrator.</DialogDescription>
          </DialogHeader>
          <ArchivedSessionsList projectId={null} />
        </DialogContent>
      </Dialog>
    </>
  );
}
