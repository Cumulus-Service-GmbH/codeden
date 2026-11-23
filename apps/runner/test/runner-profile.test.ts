import { expect, it } from "vitest";
import { runnerProfile } from "../src/runner-profile";

it("samples only aggregate resource use when profiling is enabled", () => {
  expect(runnerProfile(false)).toBeUndefined();
  const sample = runnerProfile(true);
  expect(sample?.()).toMatch(/^cpuMs=\d+\.\d rssBytes=\d+ heapUsedBytes=\d+$/);
  expect(sample?.()).toMatch(/^cpuMs=\d+\.\d rssBytes=\d+ heapUsedBytes=\d+$/);
});
