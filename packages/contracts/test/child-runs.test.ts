import { expect, it } from "vitest";
import { CHILD_RUNS_FILE_ENV, ChildRunList, ChildRunReport, foldChildRuns } from "../src";

const start = {
  id: "r1",
  role: "planReviewer",
  provider: "codex",
  model: "gpt-x",
  effort: "high",
  status: "running",
  at: "2026-11-22T21:00:00.000Z",
  detail: null,
};

it("round-trips a report and a run list", () => {
  const report = ChildRunReport.parse(start);
  expect(ChildRunReport.parse(JSON.parse(JSON.stringify(report)))).toEqual(report);
  const list = foldChildRuns([JSON.stringify(start)]);
  expect(ChildRunList.parse(JSON.parse(JSON.stringify(list)))).toEqual(list);
  expect(CHILD_RUNS_FILE_ENV).toBe("CHILD_RUNS_FILE");
});

it("folds start and end lines into runs, newest first, and counts bad lines", () => {
  const lines = [
    JSON.stringify(start),
    "not json",
    JSON.stringify({ ...start, id: "bad id" }),
    JSON.stringify({ ...start, id: "r2", role: "reviewer", at: "2026-11-22T21:01:00.000Z" }),
    JSON.stringify({
      ...start,
      status: "succeeded",
      at: "2026-11-22T21:02:00.000Z",
      detail: "CLEAN",
    }),
    // A second end for the same run is ignored.
    JSON.stringify({ ...start, status: "failed", at: "2026-11-22T21:03:00.000Z" }),
    "",
  ];
  const { runs, skipped } = foldChildRuns(lines);
  expect(skipped).toBe(3);
  expect(runs.map((r) => [r.id, r.status, r.endedAt, r.detail])).toEqual([
    ["r2", "running", null, null],
    ["r1", "succeeded", "2026-11-22T21:02:00.000Z", "CLEAN"],
  ]);
});

it("leaves the start unknown when only a run's end line was read", () => {
  const { runs } = foldChildRuns([
    JSON.stringify({ ...start, status: "failed", detail: "exit 3" }),
  ]);
  expect(runs[0]).toMatchObject({ status: "failed", startedAt: null, endedAt: start.at });
});
