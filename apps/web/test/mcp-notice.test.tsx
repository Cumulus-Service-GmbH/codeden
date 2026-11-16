import type { Session } from "@codeden/contracts";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { McpNotice } from "@/components/thread/mcp-notice";
import { createMockClient } from "@/lib/api/mock";
import { makeSession } from "@/lib/api/mock/fixtures/helpers";
import { mcpProblems } from "@/lib/mcp-status";
import { renderWithClient } from "./utils";

const session = (mcpServers: Session["mcpServers"], over: Partial<Session> = {}) =>
  makeSession({
    id: "s-mcp",
    projectId: "p-storefront",
    role: "agent",
    status: "idle",
    provider: "claude",
    purpose: "Test",
    workKey: "test:mcp",
    mcpServers,
    ...over,
  });

const troubled: Session["mcpServers"] = [
  { name: "codeden", state: "connected" },
  { name: "linear", state: "needs_sign_in" },
  { name: "db", state: "failed", error: "spawn db-mcp ENOENT" },
  { name: "slow", state: "starting" },
];

/** Reports a new server list to the mounted `Live`, as a `session.updated` would. */
let report: (next: Session["mcpServers"]) => void = () => {};

/** The notice for a session whose servers change while it is shown. */
function Live() {
  const [servers, setServers] = useState(troubled);
  report = setServers;
  return <McpNotice session={session(servers)} />;
}

describe("MCP server notice", () => {
  it("lists only failed and needs-sign-in servers of a live session with the capability", () => {
    expect(mcpProblems(session(troubled), true).map((s) => s.name)).toEqual(["linear", "db"]);
    expect(mcpProblems(session(troubled), false)).toEqual([]);
    expect(mcpProblems(session(troubled, { status: "completed" }), true)).toEqual([]);
    expect(
      mcpProblems(session(troubled, { archivedAt: "2026-11-16T10:00:00.000Z" }), true),
    ).toEqual([]);
    expect(mcpProblems(session(null), true)).toEqual([]);
  });

  it("names the servers and how to fix them, and goes away once they connect", async () => {
    renderWithClient(<Live />, createMockClient(), { withRouter: true });
    const notice = await screen.findByTestId("mcp-notice");
    expect(notice.textContent).toContain("2 MCP servers aren't available to the agent");
    expect(notice.textContent).toContain("linear (needs sign-in)");
    expect(notice.textContent).toContain("db (failed)");
    expect(notice.textContent).toContain("Claude Code's own login");
    expect(screen.getByTitle("spawn db-mcp ENOENT")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Agents › MCP servers" });
    expect(link.getAttribute("href")).toContain("tab=mcp");

    const connected = troubled?.map((s) => ({ name: s.name, state: "connected" as const }));
    act(() => report(connected));
    await waitFor(() => expect(screen.queryByTestId("mcp-notice")).toBeNull());
  });

  it("can be dismissed", async () => {
    renderWithClient(<McpNotice session={session(troubled)} />, createMockClient(), {
      withRouter: true,
    });
    await screen.findByTestId("mcp-notice");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("mcp-notice")).toBeNull();
  });
});
