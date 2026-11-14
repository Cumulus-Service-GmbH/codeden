import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { remoteImageRoutes } from "../src/routes/remote-image";
import { errorResponse } from "../src/routes/validate";
import { ServiceError } from "../src/services/errors";
import { fetchRemoteImage, isPublicAddress } from "../src/services/remote-image";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
let images: Server;
let base: string;

beforeAll(async () => {
  images = createServer((req, res) => {
    const port = (images.address() as AddressInfo).port;
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
  base = `http://127.0.0.1:${(images.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => images.close(() => resolve())));

/** The test server is on loopback: let only 127.0.0.1 through, as if it were public. */
const asPublic = { allowAddress: (a: string) => a === "127.0.0.1" };

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (error instanceof ServiceError ? error.code : String(error)),
  );

describe("remote images (#317)", () => {
  it("counts only public unicast addresses as public", () => {
    for (const address of ["93.184.216.34", "140.82.112.3", "2606:4700::6810:85e5"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.10",
      "169.254.169.254",
      "100.100.1.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "::ffff:7f00:1",
      "::ffff:127.0.0.1",
      "fd00::1",
      "fe80::1",
      "not-an-ip",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("never connects to this machine or the LAN, by address or by name", async () => {
    const port = new URL(base).port;
    expect(await failure(fetchRemoteImage(`${base}/a.png`))).toBe("address_blocked");
    expect(await failure(fetchRemoteImage(`http://localhost:${port}/a.png`))).toBe(
      "address_blocked",
    );
    expect(await failure(fetchRemoteImage(`${base}/to-local`, asPublic))).toBe("address_blocked");
  });

  it("returns images only, within the size limit, following redirects", async () => {
    expect(await fetchRemoteImage(`${base}/hop`, asPublic)).toEqual({
      contentType: "image/png",
      body: PNG,
    });
    expect(await failure(fetchRemoteImage(`${base}/page`, asPublic))).toBe("not_an_image");
    expect(await failure(fetchRemoteImage(`${base}/big`, { ...asPublic, maxBytes: 32 }))).toBe(
      "too_large",
    );
    expect(await failure(fetchRemoteImage(`${base}/missing`, asPublic))).toBe("fetch_failed");
    expect(await failure(fetchRemoteImage("http://user:pw@example.com/a.png"))).toBe("bad_url");
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
