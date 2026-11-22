import type { ProviderInfo } from "@codeden/contracts";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PermissionsField } from "@/components/automations/permissions-field";
import {
  projectRefusal,
  providerTabs,
  UNENFORCED_REASON,
} from "@/components/composer/model-picker/logic";
import { levelUnavailableReason, supportsSupervised } from "@/components/thread/autonomy";
import { renderWithClient } from "./utils";

const provider = (patch: Partial<ProviderInfo["capabilities"]>): ProviderInfo => ({
  id: "loose",
  displayName: "Loose CLI",
  models: [],
  capabilities: {
    resume: true,
    steer: false,
    interrupt: true,
    approvals: true,
    userQuestions: false,
    subagents: false,
    rollback: false,
    fork: false,
    images: true,
    planMode: true,
    reasoningEffort: true,
    mcp: true,
    skills: true,
    ...patch,
  },
});
const loose = provider({ readOnly: false, supervised: false, enforcesSecurityRules: false });

describe("permission levels a provider can't enforce", () => {
  it("are disabled, each with a reason naming the provider", () => {
    renderWithClient(
      <PermissionsField
        value="auto"
        onChange={() => {}}
        readOnlySupported={false}
        supervisedSupported={supportsSupervised(loose)}
        providerName="Loose CLI"
      />,
    );
    const readOnly = screen.getByRole("button", { name: /Read-only/ }) as HTMLButtonElement;
    const supervised = screen.getByRole("button", { name: /Supervised/ }) as HTMLButtonElement;
    expect(readOnly.disabled).toBe(true);
    expect(readOnly.textContent).toContain("Loose CLI can't enforce read-only.");
    expect(supervised.disabled).toBe(true);
    expect(supervised.textContent).toContain("Loose CLI can't enforce Supervised");
    expect((screen.getByRole("button", { name: /Auto/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("come from the capabilities alone", () => {
    expect(supportsSupervised(provider({}))).toBe(true);
    expect(supportsSupervised(provider({ supervised: false }))).toBe(false);
    expect(
      levelUnavailableReason("supervised", { readOnly: true, supervised: true }, "Loose CLI"),
    ).toBeNull();
  });
});

describe("a provider the machine's security rules don't cover", () => {
  it("shows as unavailable, with the reason, in a project that hasn't allowed it", () => {
    const refusal = projectRefusal(loose, { allowUnenforcedProviders: false });
    expect(refusal).toMatchObject({ ready: false, reason: UNENFORCED_REASON });
    expect(refusal?.detail).toContain("Allow providers without enforced security rules");
    const [tab] = providerTabs([loose], undefined, undefined, {
      project: { allowUnenforcedProviders: false },
    });
    expect(tab?.kind === "provider" && tab.availability.ready).toBe(false);
  });

  it("is available once the project allows it, and other providers are never refused", () => {
    expect(projectRefusal(loose, { allowUnenforcedProviders: true })).toBeNull();
    expect(projectRefusal(provider({}), { allowUnenforcedProviders: false })).toBeNull();
    // No project known (yet): refused all the same, fail closed.
    expect(projectRefusal(loose, null)?.ready).toBe(false);
  });
});
