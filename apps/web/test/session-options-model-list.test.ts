import { describe, expect, it } from "vitest";
import { modelListNote } from "../src/components/composer/session-options";

describe("the note after a model change", () => {
  it("says the list updates at the next session where the provider reads it at the start", () => {
    expect(modelListNote({ model: "gemini-4-argon" }, true)).toBe(
      "The model list updates at the next session.",
    );
  });

  it("says nothing for other changes, or where the list follows the provider live", () => {
    expect(modelListNote({ effort: "high" }, true)).toBeUndefined();
    expect(modelListNote({ model: "gpt-6" }, false)).toBeUndefined();
  });
});
