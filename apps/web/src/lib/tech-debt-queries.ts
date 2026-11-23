import { useQuery } from "@tanstack/react-query";
import { useClient } from "@/lib/api";

export const techDebtSummariesKey = ["tech-debt-summaries"] as const;

export function useTechDebtSummaries() {
  const { techDebt } = useClient();
  return useQuery({
    queryKey: techDebtSummariesKey,
    queryFn: () => techDebt.summaries(),
    refetchInterval: 60_000,
    staleTime: 60_000,
  });
}
