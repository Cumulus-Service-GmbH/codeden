import { RunAutomationResponse } from "@codeden/contracts";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useAutomationActions } from "@/components/automations/use-automation-actions";
import { createMockClient } from "@/lib/api/mock";
import { NewAutomationPage } from "@/routes/automation-new";
import { renderWithClient } from "./utils";

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
);
vi.mock("sonner", () => ({ toast }));

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));

const projectId = "p-storefront";
const automationId = "a-search";
const errorMessage = "The configured agent could not launch";

function failedRun(id: string) {
  const timestamp = "2026-11-12T08:00:00.000Z";
  return RunAutomationResponse.parse({
    status: "started",
    sessionId: null,
    run: {
      id: "r-search",
      automationId: id,
      projectId,
      status: "failed",
      triggeredBy: "manual",
      startedBy: { kind: "automation", id },
      purpose: "Add product search with filters",
      workKey: `automation:${id}`,
      scope: { projectId },
      progress: null,
      skipReason: null,
      sessionId: null,
      startedAt: timestamp,
      finishedAt: timestamp,
      error: { message: errorMessage },
    },
  });
}

function RunNow() {
  const actions = useAutomationActions(projectId);
  return (
    <>
      <button
        type="button"
        onClick={() => actions.run.mutate({ id: automationId, name: "Product search" })}
      >
        Run now
      </button>
      {actions.conflict && <output>{actions.conflict.existing[0]?.purpose}</output>}
    </>
  );
}

beforeEach(() => vi.clearAllMocks());

it("reports a failed launch from Run now", async () => {
  const client = createMockClient();
  client.automations.run = vi.fn().mockResolvedValue(failedRun(automationId));
  renderWithClient(<RunNow />, client, { withRouter: true });

  fireEvent.click(await screen.findByRole("button", { name: "Run now" }));

  await waitFor(() =>
    expect(toast.error.mock.calls.length + toast.success.mock.calls.length).toBeGreaterThan(0),
  );
  expect
    .soft(toast.error)
    .toHaveBeenCalledWith("Run failed", expect.objectContaining({ description: errorMessage }));
  expect(toast.success.mock.calls.map(([message]) => message)).not.toContain("Run started");
});

const runningWork = {
  id: "r-search",
  automationId,
  projectId,
  triggeredBy: "manual",
  startedBy: { kind: "automation", id: automationId },
  purpose: "Add product search with filters",
  workKey: `automation:${automationId}`,
  scope: { projectId },
  progress: null,
  startedAt: "2026-11-12T08:00:00.000Z",
};

async function runNowWith(response: RunAutomationResponse) {
  vi.useFakeTimers();
  try {
    const client = createMockClient();
    client.automations.run = vi.fn().mockResolvedValue(response);
    renderWithClient(<RunNow />, client);

    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await act(() => vi.advanceTimersByTimeAsync(1));
  } finally {
    vi.useRealTimers();
  }
}

it.each([
  { status: "started", runStatus: "running", message: "Run started" },
  { status: "queued", runStatus: "queued", message: "Queued behind running work" },
])(
  "shows the existing toast when Run now returns $status",
  async ({ status, runStatus, message }) => {
    const sessionId = "s-search";
    const response = RunAutomationResponse.parse({
      status,
      sessionId,
      behind: ["s-existing"],
      run: {
        ...runningWork,
        status: runStatus,
        skipReason: null,
        sessionId,
        finishedAt: null,
        error: null,
      },
    });
    await runNowWith(response);

    expect(toast.success).toHaveBeenCalledWith(message, {
      action: { label: "Open session", onClick: expect.any(Function) },
    });
  },
);

it("exposes the conflict without a toast when Run now returns conflicting work", async () => {
  const response = RunAutomationResponse.parse({
    status: "conflict",
    existing: [
      { ...runningWork, kind: "automation_run", status: "running", sessionId: "s-search" },
    ],
  });
  await runNowWith(response);

  expect(screen.getByRole("status").textContent).toBe(runningWork.purpose);
  for (const notify of [toast, toast.success, toast.error, toast.warning, toast.info]) {
    expect(notify).not.toHaveBeenCalled();
  }
});

it("saves and opens the automation details when Save and run now fails to launch", async () => {
  const client = createMockClient();
  const create = vi.spyOn(client.automations, "create");
  const run = vi.fn(async (id: string) => failedRun(id));
  client.automations.run = run;
  renderWithClient(<NewAutomationPage projectId={projectId} sessionId="s-search" />, client, {
    withRouter: true,
  });

  fireEvent.click(await screen.findByRole("button", { name: "Save and run now" }));

  await waitFor(() => expect(navigate).toHaveBeenCalled());
  expect(create).toHaveBeenCalledTimes(1);
  const saved = await create.mock.results[0]?.value;
  expect(run).toHaveBeenCalledWith(saved.automation.id, { projectId });
  expect(toast.success).toHaveBeenCalledWith("Add product search with filters saved, off");
  expect(navigate).toHaveBeenCalledWith({
    to: "/projects/$projectId/automations/$automationId",
    params: { projectId, automationId: saved.automation.id },
    replace: true,
  });
  expect
    .soft(toast.error)
    .toHaveBeenCalledWith("Run failed", expect.objectContaining({ description: errorMessage }));
  expect(toast.success.mock.calls.map(([message]) => message)).not.toContain("Run started");
});
