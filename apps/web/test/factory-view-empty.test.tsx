import { screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { FactoryActivity } from "@/components/factory-view/factory-activity";
import { createMockClient } from "@/lib/api/mock";
import { renderWithClient } from "./utils";

it("links to project activity when the factory pipeline is empty", async () => {
  renderWithClient(<FactoryActivity projectId="p1" projectActive />, createMockClient(), {
    withRouter: true,
  });
  expect(await screen.findByText("No factory-owned work in progress")).toBeTruthy();
  expect(screen.getByRole("link", { name: "View project activity" }).getAttribute("href")).toBe(
    "/projects/p1",
  );
});
