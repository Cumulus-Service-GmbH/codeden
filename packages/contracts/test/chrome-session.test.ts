import { expect, it } from "vitest";
import { SessionOptions } from "../src";

it("round-trips Claude in Chrome as an optional boolean", () => {
  const base = { sessionId: "s1", role: "agent", cwd: "/r", autonomy: "auto" };
  const options = SessionOptions.parse({ ...base, chrome: true });
  expect(SessionOptions.parse(JSON.parse(JSON.stringify(options))).chrome).toBe(true);
  expect(SessionOptions.parse(base).chrome).toBeUndefined();
  expect(SessionOptions.safeParse({ ...base, chrome: "yes" }).success).toBe(false);
});
