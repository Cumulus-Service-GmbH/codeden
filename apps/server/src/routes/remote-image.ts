import { RemoteImageQuery } from "@codeden/contracts";
import { Hono } from "hono";
import { type FetchRemoteImage, fetchRemoteImage } from "../services/remote-image";
import { queryOf } from "./validate";

/**
 * `/api/remote-image?url=`: a remote image the user chose to load from a Markdown placeholder
 * (§15). Served like a stored artifact: as an image only, never run as a page.
 */
export function remoteImageRoutes(fetchImage: FetchRemoteImage = (url) => fetchRemoteImage(url)) {
  return new Hono().get("/", queryOf(RemoteImageQuery), async (c) => {
    const image = await fetchImage(c.req.valid("query").url);
    return c.body(new Uint8Array(image.body), 200, {
      "content-type": image.contentType,
      "content-length": String(image.body.length),
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
      // An SVG opened on its own stays inert: no script, no further loads.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "referrer-policy": "no-referrer",
      "cache-control": "private, max-age=3600",
    });
  });
}
