/**
 * Splits live microphone audio into segments on short pauses (§11.3), so a server engine can
 * transcribe each phrase as soon as it ends instead of the whole recording on stop. Pure and
 * synchronous: push mono samples in, get finished segments back.
 *
 * Speech is told from silence by the energy (RMS) of each short frame, against a threshold that
 * follows the room's noise floor. A segment keeps a short lead-in before its first speech and a
 * short tail after its last, so words aren't clipped. One with too little speech is dropped, so
 * silence and clicks never reach Whisper, which tends to invent text for silence.
 */

export interface SegmenterOptions {
  /** Samples per second of the audio pushed in. */
  sampleRate: number;
  /** One analysis frame, in ms. */
  frameMs?: number;
  /** Silence after speech that ends a segment, in ms. */
  pauseMs?: number;
  /** Speech a segment needs to be kept, in ms. */
  minSpeechMs?: number;
  /** Audio kept before a segment's first speech, in ms. */
  leadInMs?: number;
  /** Silence kept after a segment's last speech, in ms. */
  tailMs?: number;
  /** Longest segment: longer speech is cut at its quietest recent moment, in ms. */
  maxSegmentMs?: number;
  /** Frames at or below this RMS are silence however quiet the room is. */
  minThreshold?: number;
}

export const SEGMENTER_DEFAULTS = {
  frameMs: 20,
  pauseMs: 600,
  minSpeechMs: 250,
  leadInMs: 200,
  tailMs: 300,
  maxSegmentMs: 25_000,
  minThreshold: 0.01,
} satisfies Omit<Required<SegmenterOptions>, "sampleRate">;

/** Speech is at least this many times louder than the noise floor. */
const NOISE_RATIO = 2.5;
/** The noise floor rises towards louder frames over about this long, in ms. */
const NOISE_RISE_MS = 10_000;
/** How far back a forced cut looks for the quietest frame, in ms. */
const CUT_SEARCH_MS = 2_000;

export interface Segmenter {
  /** Add samples; returns the segments they finished (usually none). */
  push(samples: Float32Array): Float32Array[];
  /** Close the open segment (on stop); returns it when it holds enough speech. */
  flush(): Float32Array[];
  /** RMS of the latest frame, 0..1: the input level for a meter. */
  readonly level: number;
}

interface Frame {
  samples: Float32Array;
  speech: boolean;
  rms: number;
}

export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

function concat(frames: Frame[]): Float32Array {
  const out = new Float32Array(frames.reduce((n, f) => n + f.samples.length, 0));
  let at = 0;
  for (const f of frames) {
    out.set(f.samples, at);
    at += f.samples.length;
  }
  return out;
}

function trailingSilence(frames: Frame[]): number {
  let n = 0;
  while (n < frames.length && !frames[frames.length - 1 - n]?.speech) n++;
  return n;
}

export function createSegmenter(options: SegmenterOptions): Segmenter {
  const o = { ...SEGMENTER_DEFAULTS, ...options };
  const frameLength = Math.max(1, Math.round((o.sampleRate * o.frameMs) / 1000));
  const frames = (ms: number) => Math.max(1, Math.round(ms / o.frameMs));
  const pauseFrames = frames(o.pauseMs);
  const minSpeechFrames = frames(o.minSpeechMs);
  const leadInFrames = frames(o.leadInMs);
  const tailFrames = frames(o.tailMs);
  const maxFrames = Math.max(frames(o.maxSegmentMs), pauseFrames + 1);
  const cutSearchFrames = Math.min(frames(CUT_SEARCH_MS), maxFrames - 1);
  const noiseRise = Math.min(1, o.frameMs / NOISE_RISE_MS);

  let partial = new Float32Array(frameLength);
  let partialLength = 0;
  let noise = 0;
  let level = 0;
  /** Recent silent frames while no segment is open: the next segment's lead-in. */
  let leadIn: Frame[] = [];
  /** The open segment; empty when none is open. */
  let open: Frame[] = [];

  /** End the open segment, keeping `tailFrames` of its trailing silence. */
  const close = (): Float32Array | null => {
    const silent = trailingSilence(open);
    const end = open.length - silent + Math.min(silent, tailFrames);
    const kept = open.slice(0, end);
    const speech = kept.filter((f) => f.speech).length;
    leadIn = open.slice(end).slice(-leadInFrames);
    open = [];
    return speech >= minSpeechFrames ? concat(kept) : null;
  };

  /** The open segment is too long: cut it at its quietest recent frame, keep the rest open. */
  const cut = (): Float32Array | null => {
    let at = open.length - 1;
    for (let i = open.length - 1; i >= open.length - cutSearchFrames; i--) {
      if ((open[i]?.rms ?? Infinity) < (open[at]?.rms ?? Infinity)) at = i;
    }
    const done = open.slice(0, at + 1);
    open = open.slice(at + 1);
    const speech = done.filter((f) => f.speech).length;
    return speech >= minSpeechFrames ? concat(done) : null;
  };

  const frame = (samples: Float32Array): Float32Array | null => {
    const r = rms(samples);
    level = Math.min(1, r);
    const speech = r > Math.max(o.minThreshold, noise * NOISE_RATIO);
    // The floor drops to quiet frames at once and rises slowly, so it follows the room (the
    // quiet between words), not the voice.
    noise = r < noise ? noise + (r - noise) * 0.5 : noise + (r - noise) * noiseRise;
    const f: Frame = { samples, speech, rms: r };
    if (open.length === 0) {
      if (!speech) {
        leadIn.push(f);
        if (leadIn.length > leadInFrames) leadIn.shift();
        return null;
      }
      open = leadIn;
      leadIn = [];
    }
    open.push(f);
    if (trailingSilence(open) >= pauseFrames) return close();
    if (open.length >= maxFrames) return cut();
    return null;
  };

  return {
    get level() {
      return level;
    },
    push(samples) {
      const out: Float32Array[] = [];
      let i = 0;
      while (i < samples.length) {
        const take = Math.min(frameLength - partialLength, samples.length - i);
        partial.set(samples.subarray(i, i + take), partialLength);
        partialLength += take;
        i += take;
        if (partialLength === frameLength) {
          const segment = frame(partial);
          partial = new Float32Array(frameLength);
          partialLength = 0;
          if (segment) out.push(segment);
        }
      }
      return out;
    },
    flush() {
      const out: Float32Array[] = [];
      if (partialLength > 0 && open.length > 0) {
        const segment = frame(partial.slice(0, partialLength));
        if (segment) out.push(segment);
      }
      partial = new Float32Array(frameLength);
      partialLength = 0;
      if (open.length > 0) {
        const segment = close();
        if (segment) out.push(segment);
      }
      leadIn = [];
      return out;
    },
  };
}
