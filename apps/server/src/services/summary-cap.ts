/** Limit the UTF-8 size of a summary without splitting a code point. */
export function capSummary(text: string, bytes: number | null): string {
  if (bytes === null || Buffer.byteLength(text) <= bytes) return text;

  const marker = `… [truncated to ${bytes} bytes; full transcript in the session]`;
  const markerBytes = Buffer.byteLength(marker);
  const suffix = markerBytes <= bytes ? marker : "";
  const budget = suffix ? bytes - markerBytes : bytes;

  let used = 0;
  let end = 0;
  for (const ch of text) {
    used += Buffer.byteLength(ch);
    if (used > budget) break;
    end += ch.length;
  }
  return text.slice(0, end) + suffix;
}
