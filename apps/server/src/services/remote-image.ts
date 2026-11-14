import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { ServiceError } from "./errors";

/**
 * "Load image" (§15): the UI's Content-Security-Policy keeps the browser from loading a remote
 * image, so when the user asks to see one, the server fetches it. Only public addresses are
 * contacted (checked at connect time, so DNS can't point a name at this machine or the LAN
 * between check and use), only images come back, within a size and time limit. No cookie,
 * referrer or credential is sent.
 */

export interface RemoteImage {
  contentType: string;
  body: Buffer;
}

export interface RemoteImageOptions {
  /** May the server connect to this address? Default: public unicast addresses only. */
  allowAddress?: (address: string) => boolean;
  maxBytes?: number;
  timeoutMs?: number;
}

export type FetchRemoteImage = (url: string) => Promise<RemoteImage>;

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

/** Image types passed on; anything else (HTML, JSON, scripts) is refused. */
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/svg+xml",
]);

/** Ranges that aren't the public internet: this machine, private networks, special use. */
const NOT_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NOT_PUBLIC.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  // NAT64 and 6to4 forms can carry any IPv4 address, private ones included. (IPv4-mapped
  // `::ffff:a.b.c.d` needs no rule: BlockList checks it against the IPv4 ranges above.)
  ["64:ff9b::", 96],
  ["2002::", 16],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  NOT_PUBLIC.addSubnet(net, prefix, "ipv6");
}

/** Is this a public unicast address (not loopback, private, link-local or special use)? */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !NOT_PUBLIC.check(address, family === 4 ? "ipv4" : "ipv6");
}

const blocked = (host: string) =>
  new ServiceError(403, "address_blocked", `${host} is not a public internet address`);

/** Fetch one image from an http(s) URL, following up to three redirects. */
export async function fetchRemoteImage(
  url: string,
  opts: RemoteImageOptions = {},
): Promise<RemoteImage> {
  const allow = opts.allowAddress ?? isPublicAddress;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS);
  let target = parseTarget(url);
  for (let hop = 0; ; hop++) {
    const res = await get(target, allow, signal);
    const location = res.headers.location;
    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
      res.resume();
      if (hop >= MAX_REDIRECTS) {
        throw new ServiceError(502, "fetch_failed", "The image redirected too many times");
      }
      target = parseTarget(new URL(location, target).href);
      continue;
    }
    return readImage(res, opts.maxBytes ?? MAX_BYTES);
  }
}

function parseTarget(url: string): URL {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new ServiceError(400, "bad_url", "Not a valid URL");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new ServiceError(400, "bad_url", "Only http and https images can be loaded");
  }
  if (target.username || target.password) {
    throw new ServiceError(400, "bad_url", "URLs with credentials are refused");
  }
  return target;
}

function get(target: URL, allow: (address: string) => boolean, signal: AbortSignal) {
  const literal = target.hostname.replace(/^\[|\]$/g, "");
  // An IP address is connected to without a lookup, so it is checked here.
  if (isIP(literal) && !allow(literal)) throw blocked(target.host);
  const lookup = guardedLookup(allow);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = send(target, {
      method: "GET",
      lookup,
      signal,
      agent: false,
      headers: { accept: "image/*", "user-agent": "CodeDen" },
    });
    req.on("response", resolve);
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ADDRESS_BLOCKED") reject(blocked(target.host));
      else if (signal.aborted) reject(new ServiceError(502, "fetch_failed", "The image timed out"));
      else
        reject(
          new ServiceError(
            502,
            "fetch_failed",
            `Couldn't load the image: ${error.code ?? error.message}`,
          ),
        );
    });
    req.end();
  });
}

/** `dns.lookup` that fails when any address of the name isn't allowed. */
function guardedLookup(allow: (address: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      const list = addresses as unknown as LookupAddress[];
      if (error) return callback(error, "", 0);
      if (list.length === 0 || list.some((a) => !allow(a.address))) {
        const refused = Object.assign(new Error(`${hostname} is not public`), {
          code: "ADDRESS_BLOCKED",
        });
        return callback(refused, "", 0);
      }
      if (options.all) {
        (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      } else {
        const first = list[0] as LookupAddress;
        callback(null, first.address, first.family);
      }
    });
  };
}

async function readImage(res: IncomingMessage, maxBytes: number): Promise<RemoteImage> {
  if (res.statusCode !== 200) {
    res.resume();
    throw new ServiceError(502, "fetch_failed", `The image's server answered ${res.statusCode}`);
  }
  const contentType = (res.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (!contentType || !IMAGE_TYPES.has(contentType)) {
    res.resume();
    throw new ServiceError(415, "not_an_image", "That URL isn't an image");
  }
  const tooLarge = () => new ServiceError(413, "too_large", "The image is too large");
  if (Number(res.headers["content-length"] ?? 0) > maxBytes) {
    res.destroy();
    throw tooLarge();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of res) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) {
        res.destroy();
        throw tooLarge();
      }
      chunks.push(chunk as Buffer);
    }
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(502, "fetch_failed", "The image download was cut off");
  }
  return { contentType, body: Buffer.concat(chunks) };
}
