import {
  ReasoningEffort,
  type Settings,
  type TeamMember,
  TeamRole,
  teamMember,
} from "@codeden/contracts";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Field } from "@/components/automations/form-bits";
import { NumberField } from "@/components/common/number-field";
import { EFFORT_NAME } from "@/components/composer/model-picker/logic";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useClient } from "@/lib/api";
import { useSnapshotData } from "@/lib/queries";
import { AgentPicker } from "./agents-tuning";
import type { TuningDraft } from "./limits-editor";

const ROLE_LABEL: Record<TeamRole, string> = {
  architect: "Architect",
  writer: "Writer",
  uiWriter: "UI writer",
  agentsMdWriter: "AGENTS.md writer",
  planReviewer: "Plan reviewer",
  reviewer: "Code reviewer",
  investigator: "Investigator",
  browserTester: "Browser tester",
  browserOperator: "Browser operator",
};

export function TeamEditor({
  tuning,
  onChange,
}: {
  tuning: TuningDraft;
  onChange: (next: TuningDraft) => void;
}) {
  const id = useId();
  const client = useClient();
  const providers = useSnapshotData((s) => s.runner.providers, []);
  const savedRemembered = useSnapshotData((s) => s.settings.teamSetup.remembered, false);
  const [remembered, setRemembered] = useState<boolean | null>(null);
  const save = useMutation({
    mutationFn: (teamSetup: Settings["teamSetup"]) => client.updateSettings({ teamSetup }),
    onError: (error) => toast.error("Setup not saved", { description: error.message }),
  });
  const { isSuccess, reset } = save;
  useEffect(() => {
    if (!isSuccess) return;
    const timer = setTimeout(reset, 2000);
    return () => clearTimeout(timer);
  }, [isSuccess, reset]);

  const { team, resultSummaryBytes } = tuning;
  const useForNewProjects = remembered ?? savedRemembered;
  const changeRole = (role: TeamRole, member: TeamMember | null) => {
    const others = team.filter((entry) => entry.role !== role);
    onChange({ ...tuning, team: member ? [...others, member] : others });
  };
  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div>
        <h3 className="text-[13px] font-medium">Team</h3>
        <p className="text-3xs text-muted-foreground">
          Pin a provider, model and effort per role. The factory uses the writer, AGENTS.md writer,
          architect and code reviewer; the project manager uses each role when it starts a session
          titled with its tag, such as [Writer]. Empty roles keep the settings above.
        </p>
      </div>
      {TeamRole.options.map((role) => {
        const label = ROLE_LABEL[role];
        const member = teamMember(team, role);
        const provider = providers.find((entry) => entry.id === member?.provider);
        const pinnedModel = member?.model;
        const staleModel = Boolean(
          pinnedModel &&
            provider?.models.length &&
            !provider.models.some(
              ({ id, resolvedId }) => id === pinnedModel || resolvedId === pinnedModel,
            ),
        );
        return (
          <div
            key={role}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 sm:grid-cols-[8rem_minmax(0,1fr)_6rem_auto]"
          >
            <span className="col-span-2 self-center text-xs sm:col-span-1">{label}</span>
            <div className="col-span-2 grid grid-cols-2 gap-2 sm:col-span-1 [&_label]:sr-only">
              <AgentPicker
                id={`${id}-${role}`}
                label={label}
                provider={member?.provider ?? ""}
                model={member?.model ?? null}
                staleModel={staleModel}
                autoValue=""
                autoLabel="Not set"
                onChange={(provider, model) =>
                  changeRole(
                    role,
                    provider ? { role, provider, model, effort: member?.effort ?? null } : null,
                  )
                }
              />
            </div>
            <select
              aria-label={`${label} effort`}
              className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13px] disabled:opacity-60"
              value={member?.effort ?? ""}
              disabled={!member}
              onChange={(event) => {
                if (member) {
                  const effort = ReasoningEffort.safeParse(event.target.value);
                  changeRole(role, { ...member, effort: effort.success ? effort.data : null });
                }
              }}
            >
              <option value="">Any</option>
              {ReasoningEffort.options.map((effort) => (
                <option key={effort} value={effort}>
                  {EFFORT_NAME[effort]}
                </option>
              ))}
            </select>
            <Button
              type="button"
              variant="ghost"
              aria-label={`Clear ${label}`}
              disabled={!member}
              onClick={() => changeRole(role, null)}
            >
              Clear
            </Button>
            {staleModel && member && provider && (
              <div className="col-span-full flex flex-wrap items-center gap-2 text-3xs text-muted-foreground">
                <span>
                  {member.model} isn't in {provider.displayName}'s current model list. Starts may
                  fail.
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => changeRole(role, { ...member, model: null })}
                >
                  Use the provider's default
                </Button>
              </div>
            )}
          </div>
        );
      })}
      <Field
        label="Result summaries for the project manager"
        htmlFor={`${id}-summary`}
        help="Maximum size in bytes. Leave empty for no limit."
      >
        <NumberField
          id={`${id}-summary`}
          optional
          min={256}
          max={65536}
          value={resultSummaryBytes}
          onChange={(resultSummaryBytes) => onChange({ ...tuning, resultSummaryBytes })}
          wrapperClassName="w-32"
          className="text-[13px]"
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={save.isPending}
          onClick={() => save.mutate({ remembered: useForNewProjects, team, resultSummaryBytes })}
        >
          Save setup
        </Button>
        <label htmlFor={`${id}-remember`} className="flex items-center gap-2">
          <Switch
            id={`${id}-remember`}
            checked={useForNewProjects}
            onCheckedChange={setRemembered}
          />
          Use for new projects
        </label>
        {isSuccess && (
          <span role="status" className="text-muted-foreground">
            Saved
          </span>
        )}
      </div>
    </div>
  );
}
