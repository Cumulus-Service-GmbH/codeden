import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/app-shell";
import { ThreadHeader } from "@/components/thread/thread-header";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiRequestError, ClientProvider, type CodeDenClient } from "@/lib/api";
import { createMockClient } from "@/lib/api/mock";
import { makeSession } from "@/lib/api/mock/fixtures/helpers";
import { useSession } from "@/lib/queries";
import { useLayoutStore } from "@/stores/layout";

/**
 * A hand-started session in a project folder that isn't a git repository (#409): it runs in
 * place, so it has no worktree, branch or base branch.
 */
const IN_PLACE = makeSession({
  id: "s-music",
  projectId: "p-storefront",
  role: "agent",
  status: "running",
  provider: "claude",
  model: "opus",
  purpose: "Research music video ideas",
  workKey: "research",
  cwd: "C:\\sandbox\\music-videos",
  worktreePath: null,
  branch: null,
  baseBranch: null,
});

/**
 * The mock client with the in-place session added, answering for its folder as the server does
 * for one without git: git requests fail with `not_a_repo`, no checkpoints are ever written, and
 * the files are listed from the folder itself.
 */
function inPlaceClient(): CodeDenClient {
  const base = createMockClient();
  return {
    ...base,
    getSnapshot: async () => {
      const snapshot = await base.getSnapshot();
      return { ...snapshot, sessions: [...snapshot.sessions, IN_PLACE] };
    },
    gitStatus: async () => {
      throw new ApiRequestError(409, "not_a_repo", `${IN_PLACE.cwd} is not a git repository`);
    },
    getDiff: async () => {
      throw new ApiRequestError(409, "no_checkpoints", "This session has no checkpoints yet");
    },
    listFiles: async () => ({
      root: IN_PLACE.cwd,
      entries: [{ path: "lyrics.md", kind: "file", sizeBytes: 12 }],
      truncated: false,
    }),
  };
}

function SessionHeader({ sessionId }: { sessionId: string }) {
  const session = useSession(sessionId);
  return session ? <ThreadHeader session={session} running={false} /> : null;
}

/** The app shell at `/sessions/<id>`, with the session's header in the centre. */
async function renderShell(sessionId: string, client: CodeDenClient) {
  const root = createRootRoute({ component: AppShell });
  const session = createRoute({
    getParentRoute: () => root,
    path: "/sessions/$sessionId",
    component: function Session() {
      const { sessionId } = session.useParams();
      return <SessionHeader sessionId={sessionId} />;
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([session]),
    history: createMemoryHistory({ initialEntries: [`/sessions/${sessionId}`] }),
  });
  render(
    <ClientProvider client={client}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>
    </ClientProvider>,
  );
  await screen.findByRole("button", { name: "More" });
}

const panel = () => screen.queryByRole("tablist");
const pressCtrlBackslash = () =>
  act(() => {
    fireEvent.keyDown(window, { key: "\\", code: "Backslash", ctrlKey: true });
  });
const openTab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));

/** Make the window match the phone media query (< 768 px), as on a 390 px wide phone. */
function asPhone() {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query.includes("max-width"),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

beforeEach(() => {
  localStorage.clear();
  useLayoutStore.setState({
    rightOpen: false,
    rightSheetOpen: false,
    rightTab: "details",
    childThread: null,
  });
});

afterEach(() => vi.restoreAllMocks());

describe("the right panel of a session without a worktree (#409)", () => {
  it("shows the right-panel toggle for an in-place session", async () => {
    await renderShell(IN_PLACE.id, inPlaceClient());
    expect(screen.getByRole("heading", { name: IN_PLACE.purpose })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Toggle right panel" })).not.toBeNull();
  });

  it("toggles the panel with Ctrl \\", async () => {
    await renderShell(IN_PLACE.id, inPlaceClient());
    expect(panel()).toBeNull();

    pressCtrlBackslash();
    expect(useLayoutStore.getState().rightOpen).toBe(true);
    await waitFor(() => expect(panel()).not.toBeNull());

    pressCtrlBackslash();
    await waitFor(() => expect(panel()).toBeNull());
  });

  it("opens with Details, Files and Browser working in the session's folder", async () => {
    await renderShell(IN_PLACE.id, inPlaceClient());
    fireEvent.click(screen.getByRole("button", { name: "Toggle right panel" }));

    // Details: the folder it runs in, in place of a worktree.
    expect(await screen.findByText("Folder")).toBeTruthy();
    expect(screen.getAllByText(IN_PLACE.cwd).length).toBeGreaterThan(0);

    openTab("Files");
    expect(await screen.findByText("lyrics.md")).toBeTruthy();

    openTab("Browser");
    expect(await screen.findByTestId("browser-panel")).toBeTruthy();
  });

  it("explains why Diff is empty in a folder that isn't a git repository", async () => {
    await renderShell(IN_PLACE.id, inPlaceClient());
    act(() => useLayoutStore.getState().openRightTab("diff"));

    const diff = await screen.findByTestId("diff-panel");
    await within(diff).findByText("Not a git repository");
    expect(diff.textContent).toContain("No diff to show");
    expect(diff.textContent).toContain(IN_PLACE.cwd);
    // No scope picker, compare or git bar for a folder without git.
    expect(within(diff).queryByRole("button", { name: "Refresh diff" })).toBeNull();
  });

  it("opens a subagent in the panel, as a subagent card's Open does", async () => {
    await renderShell(IN_PLACE.id, inPlaceClient());
    act(() => useLayoutStore.getState().openChildThread(IN_PLACE.id, "t-research-1"));
    const tab = await screen.findByRole("tab", { name: "Subagent" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
  });

  it("opens the panel as a sheet with its Terminal tab on a phone", async () => {
    asPhone();
    await renderShell(IN_PLACE.id, inPlaceClient());
    fireEvent.click(screen.getByRole("button", { name: "Toggle right panel" }));
    const sheet = await screen.findByTestId("right-sheet");
    expect(within(sheet).getByRole("tab", { name: "Terminal" })).toBeTruthy();
  });

  it("keeps the panel of a worktree session", async () => {
    await renderShell("s-checkout", createMockClient());
    await screen.findByRole("button", { name: "Toggle right panel" });
    pressCtrlBackslash();
    await waitFor(() => expect(panel()).not.toBeNull());
  });
});
