import { expect, it } from "vitest";
import {
  ChecklistItem,
  CLIENT_CAPABILITIES,
  ClientSubscribe,
  InboxItemKind,
  inboxKindVisible,
  ListInboxQuery,
  SnapshotQuery,
} from "../src";

it("round-trips declared and unknown client capabilities", () => {
  const capabilities = [...CLIENT_CAPABILITIES, "future.capability"];
  const subscribe = { type: "subscribe", fromSeq: 0, capabilities };
  expect(ClientSubscribe.parse(JSON.parse(JSON.stringify(subscribe)))).toEqual(subscribe);
  const query = { capabilities: capabilities.join(",") };
  expect(SnapshotQuery.parse(query)).toEqual(query);
  expect(ListInboxQuery.parse(query)).toEqual(query);
});

it("requires the checklist capability only for checklist approvals", () => {
  for (const kind of InboxItemKind.options) {
    expect(inboxKindVisible(kind, ["future.capability"])).toBe(kind !== "checklist_approval");
    expect(inboxKindVisible(kind, CLIENT_CAPABILITIES)).toBe(true);
  }
});

it("round-trips an optional single-line start purpose of at most 300 characters", () => {
  const item = { id: "item", text: "Work", status: "todo", updatedAt: "2026-11-22T10:00:00Z" };
  expect(ChecklistItem.parse(item)).toEqual(item);
  const approved = { ...item, startPurpose: "x".repeat(300) };
  expect(ChecklistItem.parse(JSON.parse(JSON.stringify(approved)))).toEqual(approved);
  for (const startPurpose of ["x".repeat(301), "Two\nlines"]) {
    expect(ChecklistItem.safeParse({ ...item, startPurpose }).success).toBe(false);
  }
});
