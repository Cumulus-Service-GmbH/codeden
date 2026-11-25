import {
  type FactoryTuning,
  FORK_BUILD,
  type ProviderInfo,
  type ReviewerFallback,
  reportsApiKeyLogin,
  type SetupCheck,
  SUBSCRIPTION_ONLY,
  teamMember,
} from "@codeden/contracts";
import { type ReactNode, useId } from "react";
import { Field } from "@/components/automations/form-bits";
import {
  lowerFirst,
  providerAvailability,
  providerOptionLabel,
  TOO_OLD,
} from "@/components/composer/model-picker/logic";
import { useSetupStatus, useSnapshotData } from "@/lib/queries";

/** The agent knobs of the factory's tuning: who builds and who reviews, on which model. */
export type AgentsDraft = Pick<
  FactoryTuning,
  | "builderProvider"
  | "builderModel"
  | "docsBuilderProvider"
  | "docsBuilderModel"
  | "reviewerProvider"
  | "reviewerModel"
  | "reviewerFallback"
>;

const FALLBACKS: Array<{ id: ReviewerFallback; label: string }> = [
  { id: "any", label: "Review on another model vendor" },
  { id: "wait", label: "Wait until it is available again" },
];

/** What a review does while its chosen provider can't run, by `reviewerFallback`. */
const REVIEWS_MEANWHILE: Record<ReviewerFallback, string> = {
  builder: "reviews wait",
  any: "reviews run on another model vendor",
  wait: "reviews wait",
};

const SELECT =
  "h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13px] disabled:opacity-60";

/**
 * Builder, docs builder and reviewer provider and model (§10.1), from the runner's provider
 * list. `Automatic` keeps the defaults: builders on the project's provider, reviewers on a
 * different provider from the builder's; docs build like everything else until a docs builder is
 * chosen. A model applies only to a chosen provider. Providers that can't run (from the setup
 * checks) say why, and choosing one says what happens until it can.
 */
export function AgentsTuning({
  value,
  onChange,
}: {
  value: AgentsDraft & Partial<Pick<FactoryTuning, "team">>;
  onChange: (next: AgentsDraft) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-3 border-t border-border pt-4" data-testid="agents-tuning">
      <div>
        <p className="text-[13px] font-medium">Agents</p>
        <p className="text-3xs text-muted-foreground">
          A reviewer on a different provider from the builder gives the most independent review.
          Docs builds can run on a cheaper model. Providers that aren't signed in, are too old to
          run or are at their usage limit are skipped.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <AgentPicker
          id={`${id}-b`}
          label="Builder"
          setByTeam={Boolean(teamMember(value.team, "writer"))}
          provider={value.builderProvider}
          model={value.builderModel}
          meanwhile="builders start on another available provider"
          onChange={(builderProvider, builderModel) =>
            onChange({ ...value, builderProvider, builderModel })
          }
        />
        <AgentPicker
          id={`${id}-d`}
          label="Docs builder"
          setByTeam={Boolean(teamMember(value.team, "agentsMdWriter"))}
          provider={value.docsBuilderProvider ?? ""}
          model={value.docsBuilderModel}
          autoValue=""
          autoLabel="Same as builders"
          hint="Builds of docs items (READMEs, guides, comments). Same as builders: they build on the builder's provider and model. Feature and bug builds always use the builder's."
          meanwhile="docs builds start on another available provider"
          onChange={(provider, docsBuilderModel) =>
            onChange({ ...value, docsBuilderProvider: provider || null, docsBuilderModel })
          }
        />
        <AgentPicker
          id={`${id}-r`}
          label="Reviewer"
          setByTeam={Boolean(teamMember(value.team, "reviewer"))}
          provider={value.reviewerProvider}
          model={value.reviewerModel}
          autoLabel="Automatic (a different provider from the builder)"
          meanwhile={REVIEWS_MEANWHILE[value.reviewerFallback]}
          onChange={(reviewerProvider, reviewerModel) =>
            onChange({ ...value, reviewerProvider, reviewerModel })
          }
        />
      </div>
      <Field
        label="When the reviewer's provider is unavailable"
        htmlFor={`${id}-fb`}
        hint="Unavailable means not installed, not signed in, at its usage limit, or failing to start. The review requires a provider with a known model vendor different from the author’s."
      >
        <select
          id={`${id}-fb`}
          className={SELECT}
          value={value.reviewerFallback === "builder" ? "wait" : value.reviewerFallback}
          onChange={(e) =>
            onChange({ ...value, reviewerFallback: e.target.value as ReviewerFallback })
          }
        >
          {FALLBACKS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

/**
 * A "<label> provider" picker and its "<label> model" picker, side by side in the settings grid.
 * Changing the provider resets the model to the provider's default.
 */
export function AgentPicker({
  id,
  label,
  provider,
  model,
  autoValue = "auto",
  autoLabel,
  hint,
  meanwhile,
  setByTeam = false,
  staleModel,
  modelDescribedBy,
  onChange,
}: {
  id: string;
  /** "Builder": the pickers read "Builder provider" and "Builder model". */
  label: string;
  provider: string;
  model: string | null;
  /** The value of the first option, which keeps the default ("auto"). */
  autoValue?: string;
  autoLabel?: string;
  hint?: string;
  /** What happens while the chosen provider can't run, e.g. "reviews wait". */
  meanwhile?: string;
  setByTeam?: boolean;
  staleModel?: boolean;
  modelDescribedBy?: string;
  onChange: (provider: string, model: string | null) => void;
}) {
  const providers = useSnapshotData((s) => s.runner.providers, []);
  const checks = useSetupStatus({ staleTime: 60_000 }).data?.checks;
  const keyProvider =
    FORK_BUILD && reportsApiKeyLogin(checks?.find((check) => check.id === provider)?.authMethod);
  return (
    <>
      <ProviderSelect
        id={`${id}p`}
        label={`${label} provider`}
        providers={providers}
        checks={checks}
        value={setByTeam ? autoValue : provider}
        disabled={setByTeam}
        autoValue={autoValue}
        autoLabel={setByTeam ? "Set by Team" : autoLabel}
        hint={hint}
        meanwhile={meanwhile}
        onChange={(next) => onChange(next, null)}
      />
      <ModelSelect
        id={`${id}m`}
        label={`${label} model`}
        provider={providers.find((p) => p.id === provider)}
        value={model}
        staleModel={staleModel}
        describedBy={modelDescribedBy}
        disabled={setByTeam || keyProvider}
        title={keyProvider ? SUBSCRIPTION_ONLY : undefined}
        onChange={(next) => onChange(provider, next)}
      />
    </>
  );
}

function ProviderSelect({
  id,
  label,
  providers,
  checks,
  value,
  autoValue = "auto",
  autoLabel = "Automatic",
  hint,
  meanwhile,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  providers: ProviderInfo[];
  checks: readonly SetupCheck[] | undefined;
  value: string;
  autoValue?: string;
  autoLabel?: string;
  hint?: string;
  /** What happens while the chosen provider can't run, e.g. "reviews wait". */
  meanwhile?: string;
  disabled?: boolean;
  onChange: (provider: string) => void;
}) {
  const chosen = providers.find((p) => p.id === value);
  const availability = chosen ? providerAvailability(chosen.id, checks) : null;
  let help: ReactNode;
  if (chosen && availability && !availability.ready) {
    // A CLI too old says which version it needs: "Gemini CLI 0.36.0 is too old (needs 0.68.0+)".
    const why =
      availability.reason === TOO_OLD && availability.detail
        ? availability.detail
        : `${chosen.displayName}: ${lowerFirst(availability.reason ?? "Not ready")}`;
    help = (
      <span className="text-status-waiting">
        {why}
        {availability.command && (
          <>
            {" "}
            (run <code className="rounded bg-muted px-1 font-mono">{availability.command}</code>)
          </>
        )}
        .{meanwhile && ` Until it can run, ${meanwhile}.`}
      </span>
    );
  }
  return (
    <Field label={label} htmlFor={id} hint={hint} help={help}>
      <select
        id={id}
        className={SELECT}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value={autoValue}>{autoLabel}</option>
        {providers.map((p) => {
          const availability = providerAvailability(p.id, checks);
          const blocked = availability.detail === SUBSCRIPTION_ONLY;
          return (
            <option
              key={p.id}
              value={p.id}
              disabled={blocked}
              title={blocked ? SUBSCRIPTION_ONLY : undefined}
            >
              {providerOptionLabel(p.displayName, availability)}
            </option>
          );
        })}
        {!chosen && value !== autoValue && <option value={value}>{value} (not connected)</option>}
      </select>
    </Field>
  );
}

function ModelSelect({
  id,
  label,
  provider,
  value,
  disabled,
  staleModel,
  title,
  describedBy,
  onChange,
}: {
  id: string;
  label: string;
  provider: ProviderInfo | undefined;
  value: string | null;
  disabled?: boolean;
  title?: string;
  staleModel?: boolean;
  describedBy?: string;
  onChange: (model: string | null) => void;
}) {
  const models = provider?.models ?? [];
  const listedModel =
    models.find((m) => m.id === value) ?? models.find((m) => m.resolvedId === value);
  return (
    <Field label={label} htmlFor={id}>
      <select
        id={id}
        aria-describedby={describedBy}
        title={title}
        className={SELECT}
        value={listedModel?.id ?? value ?? ""}
        disabled={disabled || !provider}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">{provider ? "Provider default" : "Choose a provider first"}</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
        {!listedModel && value && (
          <option value={value}>{staleModel ? `${value} (not listed)` : value}</option>
        )}
      </select>
    </Field>
  );
}
