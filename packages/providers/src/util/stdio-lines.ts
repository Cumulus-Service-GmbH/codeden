import type { Readable } from "node:stream";

export const STDIO_LINE_LIMIT = 10 * 1024 * 1024;

/** Frame LF/CRLF-delimited stdout without rescanning or retaining oversized records. */
export function readStdioLines(
  input: Readable,
  onLine: (line: string) => void,
  onOverflow: () => void,
): () => void {
  let partial: Buffer | undefined;
  let size = 0;
  let discarding = false;
  let stopped = false;
  const reset = () => {
    partial = undefined;
    size = 0;
    discarding = false;
  };
  const emit = (bytes: Buffer) => {
    onLine(bytes.toString("utf8", 0, bytes.at(-1) === 13 ? bytes.length - 1 : bytes.length));
  };
  const data = (chunk: Buffer) => {
    for (let offset = 0; !stopped && offset < chunk.length; ) {
      const lf = chunk.indexOf(10, offset);
      const end = lf < 0 ? chunk.length : lf;
      const length = end - offset;
      if (!discarding) {
        if (size + length > STDIO_LINE_LIMIT) {
          reset();
          discarding = true;
          onOverflow();
        } else if (lf >= 0 && size === 0) {
          emit(chunk.subarray(offset, end));
        } else {
          const needed = size + length;
          if (!partial || needed > partial.length) {
            const next = Buffer.allocUnsafe(
              Math.min(STDIO_LINE_LIMIT, Math.max(needed, (partial?.length ?? 0) * 2)),
            );
            partial?.copy(next, 0, 0, size);
            partial = next;
          }
          chunk.copy(partial, size, offset, end);
          size = needed;
          if (lf >= 0) emit(partial.subarray(0, size));
        }
      }
      if (lf < 0) return;
      reset();
      offset = lf + 1;
    }
  };
  const end = () => {
    if (!stopped && partial && size) emit(partial.subarray(0, size));
    reset();
  };
  input.on("data", data);
  input.once("end", end);
  return () => {
    stopped = true;
    input.off("data", data);
    input.off("end", end);
    reset();
  };
}
