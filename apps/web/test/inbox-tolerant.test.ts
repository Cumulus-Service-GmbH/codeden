import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpClient, parseSnapshot } from "@/lib/api/http-client";
import { inboxItem, snapshot } from "./attention-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("tolerant snapshot parsing", () => {
  it("loads a snapshot with an unknown inbox kind and skips that item", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const known = inboxItem("a", "approval");
    const raw = snapshot(3, [
      known,
      { ...inboxItem("b", "approval"), kind: "from_the_future" },
      { ...inboxItem("c", "approval"), kind: "from_the_future" },
    ] as never);
    const parsed = parseSnapshot(raw);
    expect(parsed.seq).toBe(3);
    expect(parsed.inbox.map((i) => i.id)).toEqual(["a"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("still rejects a snapshot with a broken item of a known kind", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = snapshot(1, [
      inboxItem("a", "approval"),
      { ...inboxItem("b", "approval"), status: "nonsense" },
    ] as never);
    expect(() => parseSnapshot(raw)).toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("still rejects a snapshot that is broken outside the inbox", () => {
    expect(() => parseSnapshot({ ...snapshot(1, []), seq: "x" })).toThrow();
  });

  it("asks the server for the inbox kinds this client understands", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(snapshot(1, [])), { status: 200 }));
    await createHttpClient("http://127.0.0.1:1").getSnapshot();
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:1/api/snapshot?capabilities=inbox.checklist_approval",
    );
  });

  it("declares the same capabilities on the realtime socket URL", () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "WebSocket",
      class {
        static OPEN = 1;
        constructor(url: string) {
          urls.push(url);
        }
        close() {}
      },
    );
    createHttpClient("http://127.0.0.1:1").subscribe(0, () => {});
    expect(urls).toEqual(["ws://127.0.0.1:1/ws?capabilities=inbox.checklist_approval"]);
  });
});
