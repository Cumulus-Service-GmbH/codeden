import type { CurationProposal, FactoryItem, InboxItem } from "@codeden/contracts";
import { expect, it, vi } from "vitest";
import type { FactoryContext } from "../src/services/factory/context";
import { decideCuration, proposeCuration, reviewCuration } from "../src/services/factory/curation";

vi.mock("../src/services/factory/lessons", () => ({
  curationEvidence: async () => [{ id: "verified", text: "Run the focused suite." }],
}));

const sha = "a".repeat(40);
const item = { id: "item", projectId: "project", stage: "merged" } as FactoryItem;
const operation = {
  baseSha: sha,
  path: "AGENTS.md",
  section: "## Proof",
  evidence: "verified",
  op: "replace",
  replacement: "Run the focused suite.",
} as const;
const prune = {
  baseSha: sha,
  path: ".codeden/VISION.md",
  section: "## Old goal",
  evidence: "verified",
  op: "prune",
} as const;

function setup(operations: CurationProposal["operations"] = [operation, prune]) {
  const cards = new Map<string, InboxItem>();
  const snapshot = {
    sha,
    files: {
      "AGENTS.md": "# Guide\n\n## Proof\n\nRun all tests.\n\n## Style\n\nKeep it simple.\n",
      ".codeden/VISION.md": "# Vision\n\n## Old goal\n\nOld.\n\n## Protected areas\n\n- auth\n",
    },
  };
  const publish = vi.fn<NonNullable<FactoryContext["github"]["publishCuration"]>>(async () => ({
    number: 1,
    title: "Curate project instructions",
    url: "https://example.test/pr/1",
    state: "open",
  }));
  const complete = vi.fn(async () =>
    JSON.stringify({ operations: operations.map((op) => ({ ...op, baseSha: snapshot.sha })) }),
  );
  const ctx = {
    now: () => new Date(0),
    complete,
    notify: vi.fn(),
    github: { curationSnapshot: async () => snapshot, publishCuration: publish },
    store: { item: () => item },
    inbox: {
      find: (id: string) => cards.get(id),
      get: (id: string) => cards.get(id),
      put: (card: InboxItem) => {
        cards.set(card.id, card);
        return card;
      },
      close: (card: InboxItem, status: InboxItem["status"]) => {
        const closed = { ...card, status };
        cards.set(card.id, closed);
        return closed;
      },
    },
  } as unknown as FactoryContext;
  return { ctx, cards, complete, publish, snapshot };
}

it("creates no card for empty, unchanged, append-only, out-of-scope or untrusted edits", async () => {
  for (const operations of [
    [],
    [{ ...operation, replacement: "Run all tests." }],
    [{ ...operation, replacement: "Run all tests.\nRun the focused suite." }],
    [{ ...operation, path: "README.md" }],
    [{ ...operation, evidence: "untrusted" }],
    [{ ...prune, section: "## Protected areas" }],
    [operation, operation],
  ]) {
    const { ctx, cards } = setup(operations as CurationProposal["operations"]);
    await proposeCuration(ctx, item);
    expect(cards.size).toBe(0);
  }
});

it("deduplicates concurrent proposals and requires PM review and owner approval", async () => {
  const { ctx, cards, publish } = setup();
  await Promise.all([proposeCuration(ctx, item), proposeCuration(ctx, item)]);
  expect(cards.size).toBe(1);
  const [card] = cards.values();
  if (!card) throw new Error("Expected a proposal card");
  await expect(decideCuration(ctx, card.id, "resolved")).rejects.toThrow(/PM review/);
  reviewCuration(ctx, item.projectId, card.id, "approve", "Checked exact diff and provenance.");
  expect(publish).not.toHaveBeenCalled();
  await decideCuration(ctx, card.id, "resolved");
  expect(publish).toHaveBeenCalledTimes(1);
  expect(publish.mock.calls[0]).toEqual([
    "project",
    sha,
    card.id,
    {
      "AGENTS.md": "# Guide\n\n## Proof\n\nRun the focused suite.\n\n## Style\n\nKeep it simple.\n",
      ".codeden/VISION.md": "# Vision\n\n## Protected areas\n\n- auth\n",
    },
  ]);
  expect(cards.get(card.id)?.status).toBe("resolved");
});

it("discarding a proposal writes nothing and does not raise it again", async () => {
  const { ctx, cards, publish } = setup();
  await proposeCuration(ctx, item);
  const [card] = cards.values();
  if (!card) throw new Error("Expected a proposal card");
  reviewCuration(ctx, item.projectId, card.id, "approve", "Checked.");
  await decideCuration(ctx, card.id, "dismissed");
  await proposeCuration(ctx, item);
  expect(cards.size).toBe(1);
  expect(cards.get(card.id)?.status).toBe("dismissed");
  expect(publish).not.toHaveBeenCalled();
});

it("re-proposes a stale base and requires fresh review", async () => {
  const { ctx, cards, snapshot, publish } = setup();
  await proposeCuration(ctx, item);
  const [old] = cards.values();
  if (!old) throw new Error("Expected a proposal card");
  reviewCuration(ctx, item.projectId, old.id, "approve", "Checked.");
  snapshot.sha = "b".repeat(40);
  await decideCuration(ctx, old.id, "resolved");
  const fresh = [...cards.values()].find((card) => card.status === "open");
  if (!fresh) throw new Error("Expected a fresh proposal card");
  expect(fresh.id).not.toBe(old.id);
  await expect(decideCuration(ctx, fresh.id, "resolved")).rejects.toThrow(/PM review/);
  expect(publish).not.toHaveBeenCalled();
});
