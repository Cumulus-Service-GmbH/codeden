import type { Project, Session, Snapshot } from "@codeden/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useTranscriptsStore } from "@/stores/transcripts";
import { useClient } from "./api";
import type { TranscriptState } from "./transcript/reducer";

export const snapshotKey = ["snapshot"] as const;

/** The app snapshot (projects, sessions, inbox, automations, settings), kept live by realtime. */
export function useSnapshot() {
  const client = useClient();
  return useQuery({
    queryKey: snapshotKey,
    queryFn: () => client.getSnapshot(),
    staleTime: Infinity,
  });
}

/** Select from the snapshot with a stable fallback. */
export function useSnapshotData<T>(select: (s: Snapshot) => T, fallback: T): T {
  const { data } = useSnapshot();
  return data ? select(data) : fallback;
}

export const setupKey = ["setup"] as const;

/**
 * Setup detection (installed? signed in?) for agent providers and tools (§14). The server
 * caches detection, so reading it is cheap; `staleTime` limits refetching from places that only
 * need a recent answer, such as the model picker.
 */
export function useSetupStatus(opts: { staleTime?: number } = {}) {
  const client = useClient();
  return useQuery({
    queryKey: setupKey,
    queryFn: () => client.getSetupStatus(),
    ...(opts.staleTime !== undefined ? { staleTime: opts.staleTime } : {}),
  });
}

/** Run setup detection again now, past the server's cache, and share the answer. */
export function useRecheckSetup() {
  const client = useClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.getSetupStatus({ refresh: true }),
    onSuccess: (next) => queryClient.setQueryData(setupKey, next),
  });
}

/** The query holding a session the snapshot doesn't carry, fetched by id. */
export const sessionRecordKey = (sessionId: string) => ["session-record", sessionId] as const;

/**
 * A session by id, from the snapshot, or fetched when the snapshot doesn't carry it: one
 * archived before its recent window, opened from a link, a search hit or a factory item (§6).
 * Realtime keeps the fetched copy current (`syncSessionQueries`). `loading` while fetching.
 */
export function useSessionLookup(sessionId: string | undefined): {
  session: Session | undefined;
  loading: boolean;
} {
  const client = useClient();
  const { data: snapshot } = useSnapshot();
  const listed = sessionId ? snapshot?.sessions.find((x) => x.id === sessionId) : undefined;
  const fetch = Boolean(sessionId && snapshot && !listed);
  const record = useQuery({
    queryKey: sessionRecordKey(sessionId ?? ""),
    queryFn: async () => (await client.getSessionDetail(sessionId ?? "")).session,
    enabled: fetch,
    staleTime: Infinity,
    retry: false,
  });
  return {
    session: listed ?? (fetch ? record.data : undefined),
    loading: Boolean(sessionId) && (!snapshot || (fetch && record.isLoading)),
  };
}

export function useSession(sessionId: string | undefined): Session | undefined {
  return useSessionLookup(sessionId).session;
}

export function useProject(projectId: string | null | undefined): Project | undefined {
  return useSnapshotData((s) => s.projects.find((x) => x.id === projectId), undefined);
}

/** Root turns a transcript opens with, and each page of earlier ones adds. */
export const TRANSCRIPT_PAGE_TURNS = 20;

/**
 * Load a session's transcript into the live store and return it. Only its latest root turns are
 * fetched (`turns`, a page by default), reaching back to `item` when given (a search hit), so a
 * long-lived session never downloads its whole history; `useEarlierTurns` adds earlier pages.
 * Every caller shares the session's one transcript in the store.
 */
export function useTranscript(
  sessionId: string | undefined,
  opts: { turns?: number; item?: string } = {},
): {
  transcript: TranscriptState | undefined;
  isLoading: boolean;
  error: Error | null;
} {
  const client = useClient();
  const queryClient = useQueryClient();
  const turns = opts.turns ?? TRANSCRIPT_PAGE_TURNS;
  const item = opts.item;
  const query = useQuery({
    queryKey: ["session", sessionId, turns, item ?? null],
    queryFn: () => client.getSessionSnapshot(sessionId ?? "", { turns, ...(item ? { item } : {}) }),
    enabled: Boolean(sessionId),
    staleTime: Infinity,
  });
  const resynced = useRef(false);
  useEffect(() => {
    if (!query.data) return;
    useTranscriptsStore.getState().load(query.data, { replace: resynced.current });
    resynced.current = false;
  }, [query.data]);
  // Live updates: watch the transcript from the snapshot's seq (§6).
  const seq = query.data?.seq;
  useEffect(() => {
    if (!sessionId || seq === undefined) return;
    return client.watchSession(sessionId, seq, (msg) => {
      if (msg.type === "transcript") useTranscriptsStore.getState().applyTranscript(msg);
      else {
        resynced.current = true;
        void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      }
    });
  }, [client, queryClient, sessionId, seq]);
  const transcript = useTranscriptsStore((s) => (sessionId ? s.byId[sessionId] : undefined));
  return { transcript, isLoading: query.isLoading, error: query.error };
}

/** The root turns before a loaded transcript's earliest one, and loading them a page at a time. */
export interface EarlierTurns {
  /** How many there are on the server (0 once the whole thread is loaded). */
  count: number;
  loading: boolean;
  /** Load the page before the earliest loaded turn into the session's transcript. */
  load: () => void;
}

/** Earlier root turns of a session's loaded transcript (scrolling up a long session). */
export function useEarlierTurns(sessionId: string): EarlierTurns {
  const client = useClient();
  const count = useTranscriptsStore((s) => s.byId[sessionId]?.earlierTurns ?? 0);
  const page = useMutation({
    mutationFn: async () => {
      const t = useTranscriptsStore.getState().byId[sessionId];
      const before = t?.rootThreadId ? t.threads[t.rootThreadId]?.turnIds[0] : undefined;
      if (!t || !before || t.earlierTurns === 0) return;
      const snap = await client.getSessionSnapshot(sessionId, {
        turns: TRANSCRIPT_PAGE_TURNS,
        before,
      });
      useTranscriptsStore.getState().load(snap);
    },
    onError: (error) => toast.error("Couldn't load earlier turns", { description: error.message }),
  });
  return {
    count,
    loading: page.isPending,
    load: () => {
      if (!page.isPending) page.mutate();
    },
  };
}
