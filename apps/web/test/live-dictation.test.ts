import { describe, expect, it, vi } from "vitest";
import type { DictationText, SpeechToText } from "@/lib/voice/engines";
import type { SamplesListener } from "@/lib/voice/mic-capture";
import { createSegmentQueue } from "@/lib/voice/segment-queue";
import { createSegmentedStt } from "@/lib/voice/segmented-stt";
import { createSegmenter, rms } from "@/lib/voice/segmenter";

// Synthetic audio: a 220 Hz tone stands in for speech, a faint hum for a quiet room.
const RATE = 16_000;
const samples = (ms: number, rate: number, amp: number, hz: number) =>
  Float32Array.from(
    { length: Math.round((rate * ms) / 1000) },
    (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate),
  );
const speech = (ms: number, rate = RATE) => samples(ms, rate, 0.3, 220);
const quiet = (ms: number, rate = RATE) => samples(ms, rate, 0.001, 50);
const audio = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const ms = (n: number, rate = RATE) => (rate * n) / 1000;

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("dictation segmenter", () => {
  it("splits a recording on the pause between phrases, with a short lead-in and tail", () => {
    const segmenter = createSegmenter({ sampleRate: RATE });
    const segments = segmenter.push(
      audio(quiet(500), speech(800), quiet(1000), speech(600), quiet(1000)),
    );
    expect(segments).toHaveLength(2);
    // 200 ms lead-in + the phrase + 300 ms of the pause.
    expect(segments[0]?.length).toBe(ms(200 + 800 + 300));
    expect(segments[1]?.length).toBe(ms(200 + 600 + 300));
    const first = segments[0] ?? new Float32Array();
    expect(rms(first.subarray(0, ms(200)))).toBeLessThan(0.01);
    expect(rms(first.subarray(ms(200), ms(400)))).toBeGreaterThan(0.1);
    expect(segmenter.flush()).toEqual([]);
  });

  it("drops silence and short clicks, so they never reach the engine", () => {
    const segmenter = createSegmenter({ sampleRate: RATE });
    expect(segmenter.push(audio(quiet(2000), speech(60), quiet(2000)))).toEqual([]);
    expect(segmenter.flush()).toEqual([]);
    expect(segmenter.level).toBeLessThan(0.01);
  });

  it("cuts continuous speech at its quietest moment once it reaches the longest segment", () => {
    const segmenter = createSegmenter({ sampleRate: RATE, maxSegmentMs: 3000 });
    // Words with short gaps (shorter than a pause), 4.8 s in all.
    const words = audio(...Array.from({ length: 12 }, () => audio(speech(300), quiet(100))));
    const cut = segmenter.push(words);
    expect(cut).toHaveLength(1);
    const first = cut[0] ?? new Float32Array();
    expect(first.length).toBeLessThanOrEqual(ms(3000));
    expect(first.length).toBeGreaterThan(ms(2000));
    // Cut in a gap between words, not in the middle of one.
    expect(rms(first.subarray(first.length - ms(20)))).toBeLessThan(0.01);
    // Stopping flushes the rest; nothing is lost or repeated.
    const rest = segmenter.flush();
    expect(rest).toHaveLength(1);
    expect(first.length + (rest[0]?.length ?? 0)).toBe(words.length);
  });

  it("flushes the segment still open when dictation stops mid-phrase", () => {
    const segmenter = createSegmenter({ sampleRate: RATE });
    // 510 ms: the last 10 ms are a partial frame.
    expect(segmenter.push(audio(quiet(300), speech(510)))).toEqual([]);
    expect(segmenter.level).toBeGreaterThan(0.1);
    const flushed = segmenter.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.length).toBe(ms(200 + 510));
  });
});

describe("dictation segment queue", () => {
  it("transcribes each segment once and keeps the text in order when results arrive out of order", async () => {
    const replies = [deferred<string>(), deferred<string>(), deferred<string>()];
    const transcribe = vi.fn(
      (n: number) => (replies[n] as ReturnType<typeof deferred<string>>).promise,
    );
    const updates: DictationText[] = [];
    const pending: number[] = [];
    const onError = vi.fn();
    const queue = createSegmentQueue<number>({
      transcribe,
      onText: (t) => updates.push(t),
      onPending: (n) => pending.push(n),
      onError,
    });
    queue.add(0);
    queue.add(1);
    queue.add(2);
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(3));
    expect(transcribe.mock.calls.map(([n]) => n)).toEqual([0, 1, 2]);

    replies[2]?.resolve("in checkout");
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(updates.at(-1)).toEqual({ final: "", draft: "in checkout" });
    replies[0]?.resolve(" Fix ");
    await vi.waitFor(() => expect(updates).toHaveLength(2));
    expect(updates.at(-1)).toEqual({ final: "Fix", draft: "in checkout" });
    replies[1]?.resolve("the flaky test");
    await queue.drain();
    expect(updates.at(-1)).toEqual({ final: "Fix the flaky test in checkout", draft: "" });
    expect(queue.text).toBe("Fix the flaky test in checkout");
    expect(pending).toEqual([1, 2, 3, 2, 1, 0]);
    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports the first failure once and keeps the text of every segment that succeeded", async () => {
    const transcribe = vi.fn(async (n: number) => {
      if (n === 0) return "Fix the flaky test";
      if (n === 1) throw new Error("ElevenLabs is unreachable");
      if (n === 2) throw new Error("Still unreachable");
      return "in checkout";
    });
    const onError = vi.fn();
    const onText = vi.fn();
    const queue = createSegmentQueue<number>({ transcribe, onText, onError });
    for (const n of [0, 1, 2, 3]) queue.add(n);
    await queue.drain();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("ElevenLabs is unreachable");
    expect(queue.failed).toBe(true);
    expect(queue.text).toBe("Fix the flaky test in checkout");
    queue.add(4);
    await queue.drain();
    expect(transcribe).toHaveBeenCalledTimes(4);
  });
});

/** A microphone fed by the test, at `rate` samples per second. */
function fakeMic(rate = RATE) {
  let listener: SamplesListener | null = null;
  const stop = vi.fn();
  const ready = deferred<{ stop(): void }>();
  return {
    stop,
    ready,
    capture: async (onSamples: SamplesListener) => {
      listener = onSamples;
      return ready.promise;
    },
    feed: (s: Float32Array) => listener?.(s, rate),
    open: () => ready.resolve({ stop }),
  };
}

function startEngine(engine: SpeechToText) {
  const calls = {
    text: [] as DictationText[],
    level: [] as number[],
    onEnd: vi.fn(),
    onError: vi.fn(),
  };
  engine.start({
    language: "en-US",
    onText: (t) => calls.text.push(t),
    onLevel: (l) => calls.level.push(l),
    onEnd: calls.onEnd,
    onError: calls.onError,
  });
  return calls;
}

describe("segmented dictation engine", () => {
  it("shows each phrase as it is transcribed, before stop, and flushes the last on stop", async () => {
    const mic = fakeMic(48_000);
    const transcribe = vi.fn(async (_wav: Blob, _language: string | null | undefined) =>
      transcribe.mock.calls.length === 1 ? "Fix the flaky test" : "in checkout",
    );
    const engine = createSegmentedStt({ supported: true, capture: mic.capture, transcribe });
    expect(engine.live).toBe("segments");
    expect(engine.finishesAfterStop).toBe(true);
    const calls = startEngine(engine);
    mic.open();
    mic.feed(audio(quiet(300, 48_000), speech(800, 48_000), quiet(800, 48_000)));
    await vi.waitFor(() => expect(calls.text.at(-1)?.final).toBe("Fix the flaky test"));
    expect(calls.onEnd).not.toHaveBeenCalled();
    expect(calls.level.length).toBeGreaterThan(0);
    // Sent as a 16 kHz mono WAV: 1.3 s of audio is 20,800 16-bit samples plus the header.
    const [wav, language] = transcribe.mock.calls[0] ?? [];
    expect(wav?.type).toBe("audio/wav");
    expect(wav?.size).toBe(44 + 2 * ms(1300));
    expect(language).toBe("en-US");

    mic.feed(speech(500, 48_000));
    engine.stop();
    await vi.waitFor(() => expect(calls.onEnd).toHaveBeenCalledTimes(1));
    expect(mic.stop).toHaveBeenCalled();
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(calls.text.at(-1)).toEqual({ final: "Fix the flaky test in checkout", draft: "" });
    expect(calls.onError).not.toHaveBeenCalled();
  });

  it("keeps the text already transcribed when a segment fails, and stops listening", async () => {
    const mic = fakeMic();
    const transcribe = vi.fn(async () => {
      if (transcribe.mock.calls.length === 1) return "Fix the flaky test";
      throw new Error("No OpenAI API key is set.");
    });
    const engine = createSegmentedStt({ supported: true, capture: mic.capture, transcribe });
    const calls = startEngine(engine);
    mic.open();
    mic.feed(audio(speech(600), quiet(800)));
    await vi.waitFor(() => expect(calls.text.at(-1)?.final).toBe("Fix the flaky test"));
    mic.feed(audio(speech(600), quiet(800)));
    await vi.waitFor(() => expect(calls.onEnd).toHaveBeenCalledTimes(1));
    expect(calls.onError).toHaveBeenCalledTimes(1);
    expect(calls.onError).toHaveBeenCalledWith("No OpenAI API key is set.");
    expect(mic.stop).toHaveBeenCalled();
    expect(calls.text.at(-1)).toEqual({ final: "Fix the flaky test", draft: "" });
    // Nothing more is sent once it failed.
    mic.feed(audio(speech(600), quiet(800)));
    engine.stop();
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it("sends nothing when there was no speech, and releases a microphone that opens after stop", async () => {
    const mic = fakeMic();
    const transcribe = vi.fn(async () => "never");
    const engine = createSegmentedStt({ supported: true, capture: mic.capture, transcribe });
    const calls = startEngine(engine);
    engine.stop();
    await vi.waitFor(() => expect(calls.onEnd).toHaveBeenCalledTimes(1));
    mic.open();
    await vi.waitFor(() => expect(mic.stop).toHaveBeenCalled());
    mic.feed(audio(speech(600), quiet(800)));
    expect(transcribe).not.toHaveBeenCalled();
    expect(calls.text.at(-1)).toEqual({ final: "", draft: "" });
  });

  it("reports a blocked microphone and ends", async () => {
    const engine = createSegmentedStt({
      supported: true,
      capture: async () => {
        throw new Error("Microphone access was blocked.");
      },
      transcribe: vi.fn(),
    });
    const calls = startEngine(engine);
    await vi.waitFor(() => expect(calls.onEnd).toHaveBeenCalledTimes(1));
    expect(calls.onError).toHaveBeenCalledWith("Microphone access was blocked.");
  });
});
