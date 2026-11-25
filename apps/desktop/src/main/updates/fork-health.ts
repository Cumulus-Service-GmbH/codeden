import { HealthResponse } from "@codeden/contracts";

export async function verifyForkHealth(
  port: number,
  token: string,
  version: string,
  commit: string,
  doFetch = fetch,
) {
  const base = `http://127.0.0.1:${port}`;
  await Promise.all(
    ["/health", "/api/health", "/build-info"].map(async (path) => {
      const res = await doFetch(base + path, {
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) throw new Error(`Health check failed at ${path} (${res.status})`);
      const data = await res.json();
      if (
        path === "/build-info"
          ? data?.commit !== commit || data?.version !== version
          : HealthResponse.parse(data).version !== version
      ) {
        throw new Error(`Unexpected CodeDen build at ${path}`);
      }
    }),
  );
}
