import type { Session } from "@codeden/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useClient } from "@/lib/api";

const ACTIVE = new Set<Session["status"]>(["starting", "running", "waiting"]);

export function useChildRuns(session: Session) {
  const client = useClient();
  const active = ACTIVE.has(session.status);
  const query = useQuery({
    queryKey: ["child-runs", session.id],
    queryFn: () => client.listChildRuns(session.id),
    refetchInterval: (query) =>
      active || query.state.data?.runs.some((run) => run.status === "running") ? 2000 : false,
  });
  const { refetch } = query;
  useEffect(() => {
    if (!active) void refetch();
  }, [active, refetch]);
  return query;
}
