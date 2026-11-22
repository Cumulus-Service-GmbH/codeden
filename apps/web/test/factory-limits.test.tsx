import type { Project } from "@codeden/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { describe, expect, it, vi } from "vitest";
import { AutonomyDialog } from "@/components/factory/autonomy-dialog";
import { createMockClient } from "@/lib/api/mock";
import { projects } from "@/lib/api/mock/fixtures/world";
import { renderWithClient } from "./utils";

const storefront = projects.find((p) => p.id === "p-storefront") as Project;

describe("factory settings in the autonomy dialog", () => {
  it("shows the size limits, saves an empty box as no limit and keeps valid trusted authors", async () => {
    const success = vi.spyOn(toast, "success").mockImplementation(() => "t");
    const client = createMockClient();
    const setMode = vi.spyOn(client.factory, "setMode");
    renderWithClient(<AutonomyDialog project={storefront} open onOpenChange={() => {}} />, client, {
      withRouter: true,
    });

    const lines = (await screen.findByLabelText("Largest change (lines)")) as HTMLInputElement;
    await waitFor(() => expect(lines.value).toBe("5000"));
    const files = screen.getByLabelText("Most files changed") as HTMLInputElement;
    expect(files.value).toBe("");
    expect(files.placeholder).toBe("No limit");
    expect(screen.getByText(/Lockfiles and generated files don't count/)).toBeTruthy();

    fireEvent.change(lines, { target: { value: "" } });
    fireEvent.change(files, { target: { value: "120" } });
    const authors = screen.getByLabelText("Trusted authors") as HTMLTextAreaElement;
    fireEvent.change(authors, { target: { value: "@octocat\n-not-a-login!\nmy-teammate" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(setMode).toHaveBeenCalled());
    expect(setMode.mock.calls[0]?.[1]).toMatchObject({
      mode: "dark_factory",
      limits: { autoMerge: false, trustedAuthors: ["octocat", "my-teammate"] },
      tuning: { maxChangedLines: null, maxChangedFiles: 120, requireCi: true },
    });
    success.mockRestore();
  });

  it("edits the scout's backlog threshold and the other knobs without resetting the rest", async () => {
    const success = vi.spyOn(toast, "success").mockImplementation(() => "t");
    const client = createMockClient();
    const setMode = vi.spyOn(client.factory, "setMode");
    renderWithClient(<AutonomyDialog project={storefront} open onOpenChange={() => {}} />, client, {
      withRouter: true,
    });

    const backlog = (await screen.findByLabelText("Review when fewer than")) as HTMLInputElement;
    await waitFor(() => expect(backlog.value).toBe("2"));
    expect(screen.getByText("issues wait for an agent.")).toBeTruthy();
    fireEvent.change(backlog, { target: { value: "0" } });
    expect(screen.getByText("Off: only Run scout now starts a round.")).toBeTruthy();
    // A negative number isn't a threshold: on blur the box is clamped to 0, with a note.
    fireEvent.change(backlog, { target: { value: "-3" } });
    fireEvent.blur(backlog);
    expect(backlog.value).toBe("0");
    expect(screen.getByText("The least is 0.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Revise rounds"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Watch main CI (minutes)"), { target: { value: "45" } });
    fireEvent.change(screen.getByLabelText("When the reviewer's provider is unavailable"), {
      target: { value: "wait" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(setMode).toHaveBeenCalled());
    const tuning = setMode.mock.calls[0]?.[1].tuning;
    expect(tuning).toMatchObject({
      minBacklog: 0,
      maxFixAttempts: 4,
      watchTimeoutMin: 45,
      // Unchanged knobs keep their saved values.
      discoveryIntervalMin: 360,
      maxIssuesPerRound: 3,
      maxChangedLines: 5000,
      requireCi: true,
      reviewerFallback: "wait",
      reviewerProvider: "auto",
      reviewerModel: null,
    });
    // Knobs the editor doesn't show aren't sent, so the server keeps what it has.
    expect(tuning).not.toHaveProperty("areas");
    expect(tuning).not.toHaveProperty("idleGraceMin");
    success.mockRestore();
  });

  it("routes docs builds and the scout to a provider and model of their own (#384)", async () => {
    const success = vi.spyOn(toast, "success").mockImplementation(() => "t");
    const client = createMockClient();
    const setMode = vi.spyOn(client.factory, "setMode");
    renderWithClient(<AutonomyDialog project={storefront} open onOpenChange={() => {}} />, client, {
      withRouter: true,
    });

    const docs = (await screen.findByLabelText("Docs builder provider")) as HTMLSelectElement;
    // The providers come from the runner's list in the snapshot.
    await waitFor(() => expect(docs.querySelector('option[value="claude"]')).toBeTruthy());
    expect(docs.value).toBe("");
    expect(docs.selectedOptions[0]?.textContent).toBe("Same as builders");
    const docsModel = screen.getByLabelText("Docs builder model") as HTMLSelectElement;
    expect(docsModel.disabled).toBe(true);
    fireEvent.change(docs, { target: { value: "claude" } });
    fireEvent.change(docsModel, { target: { value: "haiku" } });

    const scout = screen.getByLabelText("Scout provider") as HTMLSelectElement;
    expect(scout.value).toBe("auto");
    fireEvent.change(scout, { target: { value: "codex" } });
    fireEvent.change(screen.getByLabelText("Scout model"), {
      target: { value: "gpt-6.1-sol-mini" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(setMode).toHaveBeenCalled());
    expect(setMode.mock.calls[0]?.[1].tuning).toMatchObject({
      docsBuilderProvider: "claude",
      docsBuilderModel: "haiku",
      scoutProvider: "codex",
      scoutModel: "gpt-6.1-sol-mini",
      // Feature and bug builds keep the builder's choice.
      builderProvider: "auto",
      builderModel: null,
    });
    success.mockRestore();
  });
});

it("saves Team pins with factory tuning and replaces remembered roles in Save setup", async () => {
  const client = createMockClient();
  await client.updateSettings({
    teamSetup: {
      remembered: false,
      team: [{ role: "architect", provider: "claude", model: null, effort: null }],
      resultSummaryBytes: null,
    },
  });
  const setMode = vi.spyOn(client.factory, "setMode");
  renderWithClient(<AutonomyDialog project={storefront} open onOpenChange={() => {}} />, client, {
    withRouter: true,
  });

  const writer = await screen.findByLabelText("Writer provider", { exact: true });
  await waitFor(() => expect(writer.querySelector('option[value="codex"]')).toBeTruthy());
  fireEvent.change(writer, { target: { value: "codex" } });
  fireEvent.change(screen.getByLabelText("Writer effort"), { target: { value: "high" } });
  fireEvent.change(screen.getByLabelText("Result summaries for the project manager"), {
    target: { value: "1024" },
  });
  const builder = screen.getByLabelText<HTMLSelectElement>("Builder provider");
  expect(builder.disabled).toBe(true);
  expect(builder.selectedOptions[0]?.textContent).toBe("Set by Team");

  const team = [{ role: "writer", provider: "codex", model: null, effort: "high" }];
  fireEvent.click(screen.getByRole("switch", { name: "Use for new projects" }));
  fireEvent.click(screen.getByRole("button", { name: "Save setup" }));
  await screen.findByText("Saved");
  expect((await client.getSnapshot()).settings.teamSetup).toEqual({
    remembered: true,
    team,
    resultSummaryBytes: 1024,
  });

  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() =>
    expect(setMode.mock.calls[0]?.[1].tuning).toMatchObject({
      team,
      resultSummaryBytes: 1024,
    }),
  );
  const reloaded = await client.factory.status(storefront.id);
  expect(reloaded.tuning).toMatchObject({ team, resultSummaryBytes: 1024 });
});

it("flags stale Team model pins and lets the member follow the provider default", async () => {
  const client = createMockClient();
  const status = await client.factory.status(storefront.id);
  vi.spyOn(client.factory, "status").mockResolvedValue({
    ...status,
    tuning: {
      ...status.tuning,
      team: [
        { role: "writer", provider: "codex", model: "retired-model", effort: "high" },
        { role: "architect", provider: "claude", model: "haiku", effort: null },
      ],
    },
  });
  renderWithClient(<AutonomyDialog project={storefront} open onOpenChange={() => {}} />, client, {
    withRouter: true,
  });

  const warning = await screen.findByText(
    "retired-model isn't in Codex's current model list. Starts may fail.",
  );
  const model = screen.getByLabelText<HTMLSelectElement>("Writer model");
  expect(model.value).toBe("retired-model");
  expect(model.selectedOptions[0]?.textContent).toBe("retired-model (not listed)");
  expect(screen.getByLabelText<HTMLSelectElement>("Architect model").value).toBe("haiku");
  expect(screen.getAllByText(/isn't in .* current model list/)).toEqual([warning]);

  fireEvent.click(screen.getByRole("button", { name: "Use the provider's default" }));
  expect(model.value).toBe("");
  expect(warning.isConnected).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Save setup" }));
  await screen.findByText("Saved");
  expect((await client.getSnapshot()).settings.teamSetup.team).toContainEqual({
    role: "writer",
    provider: "codex",
    model: null,
    effort: "high",
  });
});
