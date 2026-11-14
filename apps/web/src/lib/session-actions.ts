import {
  type ArchiveSessionResponse,
  describeUnpushedWork,
  type HandoffSessionRequest,
  type ProviderInfo,
  type Session,
  type UnpushedWork,
} from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { useTranscriptsStore } from "@/stores/transcripts";
import { useUiStore } from "@/stores/ui";
import { useClient } from "./api";
import { copyWithFeedback, notifyCopyFailed } from "./copy";
import { saveMarkdown } from "./download";
import { platform } from "./platform";
import { useSnapshotData } from "./queries";

/** Sessions that can be stopped from a menu: ones with a turn running or a question open. */
export const canStop = (session: Pick<Session, "status">) =>
  session.status === "running" || session.status === "waiting";

const NOT_STARTED = new Set<Session["status"]>(["created", "queued", "starting"]);

/**
 * Whether the Fork action applies to a session at all: an agent session on a provider that
 * reports `capabilities.fork` (Principle 5: never the provider's name).
 */
export const forkSupported = (session: Session, provider: ProviderInfo | undefined) =>
  session.role === "agent" && provider?.capabilities.fork === true;

/**
 * Why a session that supports forking can't be forked right now, or null when it can (the
 * server checks the same, §9).
 */
export function forkBlocked(session: Session): string | null {
  if (session.status === "waiting") return "Answer what it's waiting on first";
  if (canStop(session)) return "Wait for the running turn to finish";
  if (NOT_STARTED.has(session.status)) return "The session hasn't started yet";
  if (!session.resumeToken) return "No conversation to fork yet";
  if (!session.branch) return "Only sessions on a git branch can be forked";
  return null;
}

/**
 * Why an agent session can't be handed off right now, or null when it can (the server checks
 * the same, §9). Unlike a fork it needs no provider capability and no resume token, but it
 * needs work: `turns` is how many turns the session has had, as the server counts them
 * (subagents' included); undefined when not known here, and then the server decides.
 */
export function handoffBlocked(session: Session, turns: number | undefined): string | null {
  if (session.status === "waiting") return "Answer what it's waiting on first";
  if (canStop(session)) return "Wait for the running turn to finish";
  if (NOT_STARTED.has(session.status)) return "The session hasn't started yet";
  if (!session.branch) return "Only sessions on a git branch can be handed off";
  if (turns === 0) return "Nothing to hand off yet";
  return null;
}

/**
 * How many turns a session has had, from its loaded transcript (the session on screen): the
 * turns loaded plus the earlier root turns still on the server; undefined when it isn't loaded.
 */
export function useTurnCount(sessionId: string): number | undefined {
  return useTranscriptsStore((s) => {
    const transcript = s.byId[sessionId];
    return transcript ? Object.keys(transcript.turns).length + transcript.earlierTurns : undefined;
  });
}

/** `handoffBlocked` for a session, with its turn count from the loaded transcript. */
export function useHandoffBlocked(session: Session): string | null {
  return handoffBlocked(session, useTurnCount(session.id));
}

/**
 * Hand a session off (§9): a new session on the chosen provider with this one's code and a
 * brief of its work, then open it. Writing the brief can take a moment (the utility model
 * summarises the work), so a loading toast shows meanwhile.
 */
export function useHandoffSession(session: Session) {
  const client = useClient();
  const navigate = useNavigate();
  const providers = useSnapshotData((s) => s.runner.providers, []);
  return useMutation({
    mutationFn: (req: HandoffSessionRequest) => client.handoffSession(session.id, req),
    onMutate: () => ({ toastId: toast.loading("Writing the handoff brief…") }),
    onSuccess: ({ sessionId }, req, context) => {
      const name = providers.find((p) => p.id === req.provider)?.displayName ?? req.provider;
      toast.success(`Continued in a new ${name} session`, {
        id: context?.toastId,
        description:
          "It has this session's code and a brief of the work. This session is unchanged.",
      });
      void navigate({ to: "/sessions/$sessionId", params: { sessionId } });
    },
    onError: (error, _vars, context) => toast.error(message(error), { id: context?.toastId }),
  });
}

/**
 * Sessions that can be turned into an automation ("Make an automation…"): agent sessions in a
 * project. PM and orchestrator sessions are conversations, not repeatable tasks.
 */
export const canMakeAutomation = (session: Pick<Session, "role" | "projectId">) =>
  session.role === "agent" && session.projectId !== null;

/** A link to the session in this CodeDen (no token: the browser's cookie signs it in). */
export const sessionLink = (sessionId: string, origin = window.location.origin) =>
  `${origin}/sessions/${encodeURIComponent(sessionId)}`;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const brief = (text: string | null) =>
  text && text.length > 160 ? `${text.slice(0, 159).trimEnd()}…` : (text ?? undefined);

/**
 * Whether pushing the session's branch would save work a container was kept for: its checked-out
 * branch has commits no remote has (#337).
 */
export const canPushFirst = (unpushed: UnpushedWork | undefined) =>
  unpushed?.current != null && unpushed.branches.some((b) => b.name === unpushed.current);

/**
 * A toast whose text takes the full width, with its buttons on a row of their own below (two
 * long labels beside the text squeeze it into a narrow column). Important: sonner's own rule for
 * the content outranks a utility.
 */
const WIDE_ACTIONS = {
  toast: "flex-wrap",
  content: "basis-[calc(100%-2rem)]!",
  actionButton: "ml-1.5!",
};

/**
 * Toast for an archive: what happened to the worktree, with Undo. A worktree kept because of
 * uncommitted changes offers Remove anyway; a removal that failed (a file still in use) offers
 * Try again. A container kept because its clone holds work that exists nowhere else (#337) says
 * what, offers Push the branch first when that would save it, and Delete anyway, saying the work
 * is deleted for good.
 */
export function announceArchive(
  result: ArchiveSessionResponse,
  actions: { undo: () => void; retry: () => void; force: () => void; push: () => void },
): void {
  const undo = { label: "Undo", onClick: actions.undo };
  const { status, message: detail, unpushed } = result.worktree;
  if (status === "removed") {
    toast.success(
      unpushed
        ? "Session archived and its container deleted"
        : "Session archived and its worktree removed",
      { action: undo, description: brief(detail) },
    );
  } else if (status === "none") {
    toast.success("Session archived", { action: undo });
  } else if (status === "kept_changes" && unpushed) {
    const work = describeUnpushedWork(unpushed);
    const remove = { label: "Delete anyway", onClick: actions.force };
    const push = { label: "Push the branch first", onClick: actions.push };
    toast.warning("Session archived. Its container was kept: it holds work that isn't pushed.", {
      description: `${work.charAt(0).toUpperCase()}${work.slice(1)}. Delete anyway deletes this work for good.`,
      action: canPushFirst(unpushed) ? push : remove,
      cancel: canPushFirst(unpushed) ? remove : undo,
      duration: 20_000,
      classNames: WIDE_ACTIONS,
    });
  } else if (status === "kept_changes") {
    toast("Session archived. The worktree has uncommitted changes, so it was kept.", {
      action: { label: "Remove anyway", onClick: actions.force },
      cancel: undo,
      duration: 10_000,
    });
  } else {
    toast.warning("Session archived, but its worktree couldn't be removed yet", {
      description: brief(detail),
      action: { label: "Try again", onClick: actions.retry },
      cancel: undo,
      duration: 10_000,
    });
  }
}

/**
 * Fork a session (§9): at its latest moment, or from a finished turn of its own ("Fork from
 * here"), then open the fork. `canFork` says whether the provider can fork at all, `blocked`
 * why it can't right now (null when it can).
 */
export function useForkSession(session: Session) {
  const client = useClient();
  const navigate = useNavigate();
  // Copying the conversation can take a moment (a provider may start a process for it).
  const fork = useMutation({
    mutationFn: (turnId: string | undefined) =>
      turnId ? client.forkSession(session.id, { turnId }) : client.forkSession(session.id),
    onMutate: () => ({ toastId: toast.loading("Forking the session…") }),
    onSuccess: ({ sessionId }, turnId, context) => {
      toast.success("Forked into a new session", {
        id: context?.toastId,
        description: turnId
          ? "It has the conversation and the code as they were after that turn. The original is unchanged."
          : "It has the conversation and the code so far. The original is unchanged.",
      });
      void navigate({ to: "/sessions/$sessionId", params: { sessionId } });
    },
    onError: (error, _vars, context) => toast.error(message(error), { id: context?.toastId }),
  });
  const provider = useSnapshotData(
    (s) => s.runner.providers.find((p) => p.id === session.provider),
    undefined,
  );
  const canFork = forkSupported(session, provider);
  return {
    canFork,
    blocked: canFork ? (fork.isPending ? "Forking…" : forkBlocked(session)) : null,
    /** A fork is under way (its "Forking the session…" toast is showing). */
    pending: fork.isPending,
    /** Fork at the latest moment, or through the end of `turnId`. */
    fork: (turnId?: string) => fork.mutate(turnId),
  };
}

/** The second line under Copy and Download as Markdown: the export hides secrets (§13). */
export const MARKDOWN_HINT = "Secrets redacted";

/**
 * What you can do to a session from its row menu, the thread header's ⋯ menu or the command
 * palette: open, rename, copy its link, copy or download it as Markdown, make an automation from
 * it, stop, fork, archive (with Undo) and unarchive. They all use this, so they show the same
 * toasts.
 */
export function useSessionActions(session: Session) {
  const client = useClient();
  const navigate = useNavigate();
  const onError = (error: unknown) => toast.error(message(error));

  const stop = useMutation({
    mutationFn: () => client.stopSession(session.id),
    onSuccess: () => toast("Session stopped"),
    onError,
  });
  const unarchive = useMutation({
    mutationFn: () => client.unarchiveSession(session.id),
    onSuccess: () => toast.success("Session restored to the sidebar"),
    onError,
  });
  const announce = (result: ArchiveSessionResponse, force: boolean) =>
    announceArchive(result, {
      undo: () => unarchive.mutate(),
      retry: () => archive.mutate(force),
      force: () => archive.mutate(true),
      push: () => pushThenArchive.mutate(),
    });
  const archive = useMutation({
    mutationFn: (force: boolean) => client.archiveSession(session.id, { force }),
    onSuccess: announce,
    onError,
  });
  // A container kept for unpushed commits (#337): push its branch (with the brokered GitHub
  // credential), then archive again, which removes the container when nothing else is left.
  const pushThenArchive = useMutation({
    mutationFn: async () => {
      await client.gitPush(session.id, {});
      return client.archiveSession(session.id, { force: false });
    },
    onSuccess: (result) => announce(result, false),
    onError: (error) => toast.error("Couldn't push the branch", { description: message(error) }),
  });
  const rename = useMutation({
    mutationFn: (title: string) => client.updateSession(session.id, { title }),
    onError,
  });
  // Share the transcript (§13): the server writes the Markdown, every thread included.
  const exportMarkdown = useMutation({
    mutationFn: async (how: "copy" | "download") => {
      const file = await client.exportSession(session.id);
      if (how === "download") {
        saveMarkdown(file.fileName, file.markdown);
        return { how, fileName: file.fileName, copied: false };
      }
      // Fetched first, so the click's gesture may have expired; a failed copy says so itself.
      const copied = await platform.writeClipboard(file.markdown);
      if (!copied) notifyCopyFailed();
      return { how, fileName: file.fileName, copied };
    },
    onSuccess: ({ how, fileName, copied }) => {
      if (how === "download") toast.success(`Downloaded ${fileName}`);
      else if (copied) toast.success("Copied as Markdown");
    },
    onError: (error) => toast.error("Couldn't export the session", { description: message(error) }),
  });
  const fork = useForkSession(session);
  const setHandoff = useUiStore((s) => s.setHandoff);
  const blocked = useHandoffBlocked(session);

  return {
    open: () => void navigate({ to: "/sessions/$sessionId", params: { sessionId: session.id } }),
    /** Save a new title; blank or unchanged titles are ignored. */
    rename: (title: string) => {
      const next = title.trim().slice(0, 200);
      if (next && next !== (session.title ?? session.purpose)) rename.mutate(next);
    },
    copyLink: async () => {
      await copyWithFeedback(sessionLink(session.id), "Link copied");
    },
    /** Copy the transcript as Markdown, to paste into an issue, a PR or a write-up. */
    copyMarkdown: () => exportMarkdown.mutate("copy"),
    /** Download the transcript as a `.md` file. */
    downloadMarkdown: () => exportMarkdown.mutate("download"),
    canMakeAutomation: canMakeAutomation(session),
    /** Open the New automation editor prefilled from this session; nothing is saved yet. */
    makeAutomation: () => {
      if (!session.projectId) return;
      void navigate({
        to: "/projects/$projectId/automations/new",
        params: { projectId: session.projectId },
        search: { session: session.id },
      });
    },
    canStop: canStop(session),
    stop: () => stop.mutate(),
    archived: Boolean(session.archivedAt),
    archive: () => archive.mutate(false),
    unarchive: () => unarchive.mutate(),
    /** The provider can fork this session's conversation: show the Fork action. */
    canFork: fork.canFork,
    /** Why Fork is disabled right now (null when it can run). */
    forkBlocked: fork.blocked,
    fork: () => fork.fork(),
    /** Agent sessions can be handed off to any provider: show the Hand off action. */
    canHandoff: session.role === "agent",
    /** Why Hand off is disabled right now (null when it can run). */
    handoffBlocked: session.role === "agent" ? blocked : null,
    /** Open the handoff dialog, with `provider` chosen when given. */
    handoff: (provider?: string) =>
      setHandoff({ sessionId: session.id, provider: provider ?? null }),
  };
}

export type SessionActions = ReturnType<typeof useSessionActions>;
