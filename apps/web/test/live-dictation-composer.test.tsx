import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerBox } from "@/components/composer/composer-box";
import type { SpeechToText } from "@/lib/voice/engines";
import type { SamplesListener } from "@/lib/voice/mic-capture";
import { createSegmentedStt } from "@/lib/voice/segmented-stt";
import { getDraft, useComposerStore } from "@/stores/composer";
import { renderWithClient } from "./utils";

const RATE = 16_000;
const tone = (ms: number, amp: number) =>
  Float32Array.from(
    { length: (RATE * ms) / 1000 },
    (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / RATE),
  );
/** A phrase followed by a pause long enough to end its segment. */
const phrase = () => {
  const out = new Float32Array(tone(700, 0.3).length + tone(800, 0.001).length);
  out.set(tone(700, 0.3));
  out.set(tone(800, 0.001), tone(700, 0.3).length);
  return out;
};

const KEY = "s-live-dictation";
const textbox = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const mic = () => screen.getByRole("button", { name: /^(Dictate|Stop dictation|Transcribing)/ });

function renderComposer(engine: SpeechToText) {
  return renderWithClient(
    <ComposerBox
      draftKey={KEY}
      placeholder="Message the agent"
      onKeyDown={() => {}}
      dictationEngine={engine}
    >
      <span />
    </ComposerBox>,
  );
}

beforeEach(() => {
  useComposerStore.setState({ drafts: {} });
  useComposerStore.getState().setText(KEY, "Fix");
});

describe("live dictation in the composer", () => {
  it("shows text phrase by phrase while speaking, and the joined segments after stop", async () => {
    let feed: SamplesListener = () => {};
    const replies = ["the flaky test", "in checkout", "please"];
    const transcribe = vi.fn(async () => replies[transcribe.mock.calls.length - 1] ?? "");
    const engine = createSegmentedStt({
      supported: true,
      capture: async (onSamples) => {
        feed = onSamples;
        return { stop: () => {} };
      },
      transcribe,
    });
    renderComposer(engine);
    fireEvent.click(mic());
    expect(mic().getAttribute("aria-pressed")).toBe("true");
    // Before any text: a "Listening…" indicator, then a live level once audio arrives.
    expect(screen.getByRole("status").textContent).toMatch(/^Listening…/);
    await act(async () => feed(tone(200, 0.001), RATE));
    expect(screen.getByTestId("dictation-level")).toBeTruthy();

    await act(async () => feed(phrase(), RATE));
    await waitFor(() => expect(textbox().value).toBe("Fix the flaky test"));
    // Still listening: the text arrived before stop.
    expect(mic().getAttribute("aria-pressed")).toBe("true");
    await act(async () => feed(phrase(), RATE));
    await waitFor(() => expect(textbox().value).toBe("Fix the flaky test in checkout"));

    // Stop mid-phrase: the last segment is flushed and transcribed.
    await act(async () => feed(tone(500, 0.3), RATE));
    fireEvent.click(mic());
    await waitFor(() => expect(screen.queryByTestId("dictation-strip")).toBeNull());
    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(textbox().value).toBe("Fix the flaky test in checkout please");
    expect(getDraft(useComposerStore.getState(), KEY).text).toBe(
      "Fix the flaky test in checkout please",
    );
    expect(mic().getAttribute("aria-pressed")).toBe("false");
  });

  it("shows text in progress muted, outside the draft, until it settles", () => {
    let handlers: Parameters<SpeechToText["start"]>[0] | undefined;
    const engine: SpeechToText = {
      supported: true,
      live: "interim",
      finishesAfterStop: false,
      start: (o) => {
        handlers = o;
      },
      stop: vi.fn(),
    };
    renderComposer(engine);
    fireEvent.click(mic());
    // No level from this engine: a pulsing dot and "Listening…".
    expect(screen.queryByTestId("dictation-level")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Listening…");
    act(() => handlers?.onText({ final: "", draft: "the fla" }));
    expect(screen.getByTestId("dictation-draft").textContent).toBe("the fla");
    expect(textbox().value).toBe("Fix");
    act(() => handlers?.onText({ final: "the flaky test", draft: "" }));
    expect(textbox().value).toBe("Fix the flaky test");
    expect(screen.queryByTestId("dictation-draft")).toBeNull();
    fireEvent.click(mic());
    expect(engine.stop).toHaveBeenCalled();
    expect(screen.queryByTestId("dictation-strip")).toBeNull();
  });

  it("waits for the last segments after stop, then keeps the text when an error ends dictation", () => {
    let handlers: Parameters<SpeechToText["start"]>[0] | undefined;
    const engine: SpeechToText = {
      supported: true,
      live: "segments",
      finishesAfterStop: true,
      start: (o) => {
        handlers = o;
      },
      stop: vi.fn(),
    };
    renderComposer(engine);
    fireEvent.click(mic());
    act(() => handlers?.onText({ final: "the flaky test", draft: "" }));
    act(() => handlers?.onPending?.(1));
    expect(screen.getByRole("status").textContent).toBe("Transcribing…");
    fireEvent.click(mic());
    expect(mic().getAttribute("aria-label")).toBe("Transcribing…");
    expect((mic() as HTMLButtonElement).disabled).toBe(true);
    act(() => handlers?.onError("The network is down."));
    act(() => handlers?.onEnd());
    expect(textbox().value).toBe("Fix the flaky test");
    expect((mic() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("dictation-strip")).toBeNull();
  });

  it("is disabled when no engine is available", () => {
    const engine: SpeechToText = {
      supported: false,
      live: "interim",
      finishesAfterStop: false,
      start: vi.fn(),
      stop: vi.fn(),
    };
    renderComposer(engine);
    const button = screen.getByRole("button", { name: /^Dictation isn't available/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
