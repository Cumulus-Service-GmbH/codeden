import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publicFetch } from "../src/network/public-fetch";
import { remoteImageRoutes } from "../src/routes/remote-image";
import { errorResponse } from "../src/routes/validate";
import { ServiceError } from "../src/services/errors";
import { fetchRemoteImage } from "../src/services/remote-image";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
let images: Server;
let port: number;

beforeAll(async () => {
  images = createServer((req, res) => {
    const routes: Record<string, () => void> = {
      "/a.png": () => res.writeHead(200, { "content-type": "image/png" }).end(PNG),
      "/page": () => res.writeHead(200, { "content-type": "text/html" }).end("<script>1</script>"),
      "/big": () => res.writeHead(200, { "content-type": "image/png" }).end(Buffer.alloc(64)),
      "/hop": () => res.writeHead(302, { location: "/a.png" }).end(),
      "/to-local": () => res.writeHead(302, { location: `http://[::1]:${port}/a.png` }).end(),
      "/missing": () => res.writeHead(404).end(),
    };
    (routes[req.url ?? ""] ?? routes["/missing"])?.();
  });
  await new Promise<void>((resolve) => images.listen(0, "127.0.0.1", resolve));
  port = (images.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => images.close(() => resolve())));

/**
 * `https://images.test` stands for a public host, served by the local test server; every other
 * URL goes to the real `publicFetch`, which refuses this machine and private networks.
 */
const seen: string[] = [];
const scripted: typeof fetch = (input, init) => {
  const url = new URL(String(input));
  seen.push(url.href);
  if (url.host !== "images.test") return publicFetch(input, init);
  return fetch(`http://127.0.0.1:${port}${url.pathname}`, { ...init, redirect: "manual" });
};

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (error instanceof ServiceError ? error.code : String(error)),
  );

describe("remote images (#317)", () => {
  it("never reaches this machine or a private network, by address, name or redirect", async () => {
    for (const url of [
      `http://127.0.0.1:${port}/a.png`,
      `https://localhost:${port}/a.png`,
      "https://[::1]/a.png",
      "https://192.168.1.1/a.png",
    ]) {
      expect(await failure(fetchRemoteImage(url)), url).toBe("address_blocked");
    }
    const redirected = fetchRemoteImage("https://images.test/to-local", { fetch: scripted });
    expect(await failure(redirected)).toBe("address_blocked");
  });

  it("returns images only, over https, within the size limit, following redirects", async () => {
    seen.length = 0;
    expect(await fetchRemoteImage("http://images.test/hop", { fetch: scripted })).toEqual({
      contentType: "image/png",
      body: PNG,
    });
    expect(seen).toEqual(["https://images.test/hop", "https://images.test/a.png"]);
    const get = (path: string, maxBytes?: number) =>
      failure(fetchRemoteImage(`https://images.test${path}`, { fetch: scripted, maxBytes }));
    expect(await get("/page")).toBe("not_an_image");
    expect(await get("/big", 32)).toBe("too_large");
    expect(await get("/missing")).toBe("fetch_failed");
    expect(await failure(fetchRemoteImage("https://user:pw@example.com/a.png"))).toBe("bad_url");
    expect(await failure(fetchRemoteImage("ftp://example.com/a.png"))).toBe("bad_url");
  });

  it("serves the image inert: no sniffing, no script, sandboxed", async () => {
    const app = new Hono()
      .onError((error, c) => errorResponse(error, c))
      .route(
        "/",
        remoteImageRoutes(async () => ({ contentType: "image/svg+xml", body: PNG })),
      );
    const res = await app.request(`/?url=${encodeURIComponent("https://a.example/x.svg")}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
    expect((await app.request("/?url=file:///etc/passwd")).status).toBe(400);
  });
});
