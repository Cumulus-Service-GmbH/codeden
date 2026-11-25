import {
  CODEDEN_VERSION,
  type DiskHygieneCommand,
  DiskHygieneConfig,
  DiskHygieneStatus,
} from "@codeden/contracts";
import type { Fetcher } from "./http";

export interface DiskHygieneApi {
  status(): Promise<DiskHygieneStatus>;
  command(command: DiskHygieneCommand): Promise<DiskHygieneStatus>;
}

export function httpDiskHygieneApi(http: Fetcher): DiskHygieneApi {
  return {
    status: () => http.get("/disk-hygiene", DiskHygieneStatus.parse),
    command: (body) => http.post("/disk-hygiene", body, DiskHygieneStatus.parse),
  };
}

export function mockDiskHygieneApi(): DiskHygieneApi {
  let config = DiskHygieneConfig.parse({});
  const status = async () => ({
    config,
    version: CODEDEN_VERSION,
    approved: false,
    previewId: null,
    report: null,
    history: [],
  });
  return {
    status,
    command: async (command) => {
      if (command.action === "configure") config = command.config;
      return status();
    },
  };
}
