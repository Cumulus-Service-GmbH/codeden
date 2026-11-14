import { z } from "zod";

/**
 * How the UI keeps Markdown from contacting other hosts (§15): the Content-Security-Policy the
 * server sends with the UI and the desktop app sets on its window, and the image fetch behind
 * "Load image". Agent replies and GitHub text can carry image URLs that encode data, so the
 * browser never loads a remote image by itself.
 */

/** Where the UI loads a remote image the user chose to see, through the server. */
export const REMOTE_IMAGE_PATH = "/api/remote-image";

/** `GET /api/remote-image?url=`: one image from an http or https URL, fetched by the server. */
export const RemoteImageQuery = z.object({
  url: z.url({ protocol: /^https?$/ }).max(2_048),
});
export type RemoteImageQuery = z.infer<typeof RemoteImageQuery>;

/** A `Host` value (`127.0.0.1:4317`, `[::1]:80`, `my-pc.local`); nothing that could end a directive. */
const HOST = /^[a-z0-9.\-[\]:]+$/i;

/**
 * The UI's Content-Security-Policy:
 * - images, fonts and media only from CodeDen itself, `data:` and `blob:` (screencast frames,
 *   pasted images, recorded audio), so an `<img>` in Markdown can't reach another host;
 * - scripts only from CodeDen's own files: no inline or remote script, no `eval`;
 * - network requests only to CodeDen, its WebSockets included;
 * - never framed by another page, no plugins, no `<base>` or form posts elsewhere.
 *
 * `host` is the `Host` the UI was loaded from (`127.0.0.1:4317`): its `ws:` and `wss:` origins
 * are listed too, for browsers whose `'self'` doesn't cover WebSockets.
 */
export function uiContentSecurityPolicy(host?: string): string {
  const sockets = host && HOST.test(host) ? ` ws://${host} wss://${host}` : "";
  return [
    "default-src 'self'",
    "script-src 'self'",
    // Inline style attributes and the style tags UI libraries insert.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    `connect-src 'self'${sockets}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
