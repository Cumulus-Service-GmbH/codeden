import {
  type TechDebtAction,
  TechDebtList,
  TechDebtSummaries,
  type TechDebtSummary,
  TechDebtView,
} from "@codeden/contracts";
import type { Fetcher } from "./http";

export interface TechDebtApi {
  summaries(): Promise<TechDebtSummary[]>;
  list(projectId: string): Promise<TechDebtList>;
  act(projectId: string, action: TechDebtAction): Promise<TechDebtView>;
}

export function httpTechDebtApi(http: Fetcher): TechDebtApi {
  const path = (id: string) => `/projects/${encodeURIComponent(id)}/tech-debt`;
  return {
    summaries: () => http.get("/tech-debt", TechDebtSummaries.parse),
    list: (id) => http.get(path(id), TechDebtList.parse),
    act: (id, action) => http.post(path(id), action, TechDebtView.parse),
  };
}
