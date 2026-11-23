import type { Session } from "@codeden/contracts";
import { expect, it } from "vitest";
import { compactSession } from "../src/mcp/tools/shared/helpers";
import { deriveNotices } from "../src/services/orchestration/notices";
import { capSummary } from "../src/services/summary-cap";
import { sampleSession } from "./helpers";

it("cuts at a UTF-8 code-point boundary and budgets for the marker", () => {
  const summary = "😀".repeat(100);
  const marker = "… [truncated to 256 bytes; full transcript in the session]";
  const capped = capSummary(summary, 256);
  expect(capped).toBe("😀".repeat(Math.floor((256 - Buffer.byteLength(marker)) / 4)) + marker);
  expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(256);
});

it("preserves an uncapped summary and one that fits exactly", () => {
  const summary = "é".repeat(128);
  expect(capSummary(summary, null)).toBe(summary);
  expect(capSummary(summary, 256)).toBe(summary);
});

it("caps the PM completion notice and the compact tool result while preserving the full result", () => {
  const summary = "😀".repeat(100);
  const session: Session = {
    ...sampleSession,
    projectId: "project",
    rootThreadId: "thread",
    startedBy: { kind: "pm", id: "pm", reportTo: "orchestrator" },
    result: { outcome: "success", summary, at: sampleSession.updatedAt },
  };
  const notices = deriveNotices(
    [
      {
        seq: 1,
        ts: session.updatedAt,
        sessionId: session.id,
        type: "agent.turn.completed",
        payload: { type: "turn.completed", threadId: "thread", turnId: "turn" },
      },
    ],
    {
      session: () => session,
      finalMessage: () => null,
      resultSummaryBytes: (projectId) => (projectId === "project" ? 256 : null),
    },
  );
  expect(notices.map(({ notice }) => notice.data)).toEqual([
    expect.objectContaining({ summary: capSummary(summary, 256) }),
    expect.objectContaining({ summary }),
  ]);
  expect(compactSession(session, { summaryBytes: 256 }).result?.summary).toBe(
    capSummary(summary, 256),
  );
  expect(session.result?.summary).toBe(summary);
});

it("uses the whole budget for the prefix when the marker does not fit", () => {
  expect(capSummary("é😀tail", 5)).toBe("é");
  expect(capSummary("abcdef", 2)).toBe("ab");
});
