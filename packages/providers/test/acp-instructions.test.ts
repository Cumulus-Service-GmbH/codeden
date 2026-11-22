import { describe, expect, it } from "vitest";
import { promptBlocks, withInstructions } from "../src/acp/items";

// #602: ACP agents take no system prompt, so CodeDen's (with the token saver note) goes in front
// of the first prompt.
describe("ACP instructions", () => {
  const input = { text: "Fix the build", attachments: [] };
  const system =
    "# Working inside CodeDen\n\n## Token saver\n\nToken saver is on for this session (lite).";

  it("prefixes the first prompt with the system prompt, token saver note included", () => {
    const [first] = promptBlocks(withInstructions(input, system), false);
    expect(first).toEqual({
      type: "text",
      text: `<instructions>\n${system}\n</instructions>\n\nFix the build`,
    });
  });

  it("leaves the prompt alone without instructions", () => {
    expect(withInstructions(input, undefined)).toBe(input);
  });
});
