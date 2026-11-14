import { describe, expect, it } from "vitest";
import { RemoteImageQuery, uiContentSecurityPolicy } from "../src";

describe("content security contracts (#317)", () => {
  it("round-trips a remote image query and accepts only http and https URLs", () => {
    const query = { url: "https://user-images.githubusercontent.com/1/shot.png?x=1" };
    expect(RemoteImageQuery.parse(JSON.parse(JSON.stringify(query)))).toEqual(query);
    expect(RemoteImageQuery.safeParse({ url: "http://example.com/a.png" }).success).toBe(true);
    for (const url of [
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "file:///etc/passwd",
      "ftp://example.com/a.png",
      "/api/artifacts/a1",
      `https://example.com/${"a".repeat(2_048)}`,
    ]) {
      expect(RemoteImageQuery.safeParse({ url }).success, url).toBe(false);
    }
  });

  it("limits images to CodeDen, data: and blob:, scripts to CodeDen, and is never framed", () => {
    const csp = uiContentSecurityPolicy("127.0.0.1:4317");
    const directives = new Map(
      csp.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1).join(" ")]),
    );
    expect(directives.get("img-src")).toBe("'self' data: blob:");
    expect(directives.get("script-src")).toBe("'self'");
    expect(directives.get("connect-src")).toBe("'self' ws://127.0.0.1:4317 wss://127.0.0.1:4317");
    expect(directives.get("frame-ancestors")).toBe("'none'");
    expect(directives.get("object-src")).toBe("'none'");
    expect(csp).not.toMatch(/https?:|\*|unsafe-eval/);
  });

  it("leaves out a host that could inject a directive", () => {
    expect(uiContentSecurityPolicy("evil.example; img-src *")).not.toContain("evil");
    expect(uiContentSecurityPolicy()).toContain("connect-src 'self';");
  });
});
