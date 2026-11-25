import { SUBSCRIPTION_ONLY } from "@codeden/contracts";
import { fireEvent, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AgentPicker } from "@/components/factory/agents-tuning";
import { EngineSelect } from "@/components/settings/image-controls";
import { VoiceSettings } from "@/components/settings/sections-voice";
import { createMockClient } from "@/lib/api/mock";
import { renderWithClient } from "./utils";

it.each(["Gemini image models", "OpenAI Images"])("disables the %s image engine", async (name) => {
  renderWithClient(<EngineSelect label="Image engine" value="auto" onChange={vi.fn()} />);
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  const option = await screen.findByRole("option", { name });
  expect(option.getAttribute("aria-disabled")).toBe("true");
  expect(option.getAttribute("title")).toBe(SUBSCRIPTION_ONLY);
});

it.each([
  ["OpenAI", 0],
  ["ElevenLabs", 0],
  ["ElevenLabs", 1],
])("disables the %s voice service at index %d", (name, index) => {
  renderWithClient(<VoiceSettings />);
  const option = screen.getAllByRole<HTMLButtonElement>("button", { name })[index];
  expect(option?.disabled).toBe(true);
  expect(option?.title).toBe(SUBSCRIPTION_ONLY);
});

it("disables a factory provider using an API key", async () => {
  const client = createMockClient();
  const status = await client.getSetupStatus();
  vi.spyOn(client, "getSetupStatus").mockResolvedValue({
    ...status,
    checks: status.checks.map((check) =>
      check.id === "codex" ? { ...check, authMethod: "api key" } : check,
    ),
  });
  renderWithClient(
    <AgentPicker id="builder" label="Builder" provider="codex" model={null} onChange={vi.fn()} />,
    client,
  );
  const option = await screen.findByRole<HTMLOptionElement>("option", {
    name: /Codex.*api-key login/i,
  });
  expect(option.disabled).toBe(true);
  expect(option.title).toBe(SUBSCRIPTION_ONLY);
  const model = screen.getByLabelText<HTMLSelectElement>("Builder model");
  expect(model.disabled).toBe(true);
  expect(model.title).toBe(SUBSCRIPTION_ONLY);
});
