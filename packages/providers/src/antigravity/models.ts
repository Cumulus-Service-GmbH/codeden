import type { ModelInfo, ReasoningEffort } from "@codeden/contracts";
import { findOption, optionValues } from "../acp/config";
import type { AcpSessionSetup } from "../acp/protocol";
import { DEFAULT_MODEL_ID } from "../util/model";

const CONFIGURED_MODEL = "The model selected in the Antigravity CLI (its own setting)";

/**
 * The Antigravity CLI's thinking levels (its `thought_level` option), lowest first. Each is also
 * a CodeDen effort of the same name.
 */
const LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ReasoningEffort[];
type Level = (typeof LEVELS)[number];
const isLevel = (value: string): value is Level => (LEVELS as readonly string[]).includes(value);

/** The levels its documentation lists (Low, Medium, High, Extra), until a session lists its own. */
const DOCUMENTED: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

/**
 * The `thought_level` value for a CodeDen effort, among the values the session lists. Same-named
 * levels map directly; `minimal`, which the CLI lacks, becomes `low`. An effort the session
 * doesn't list takes the nearest lower level it does (a model without `max` runs `max` at
 * `xhigh`), else the nearest higher one. Pure.
 */
/**
 * `thoughtLevel` for the session's current model: of the levels `thought_level` lists, only those
 * the model offers (its `models.availableModels` variants, `gemini-4-argon-high`), when the
 * session names any for it, so an effort never runs above the model's own maximum.
 */
export function modelThoughtLevel(
  effort: ReasoningEffort,
  listed: readonly string[],
  setup: AcpSessionSetup,
): string | undefined {
  const model = findOption(setup.configOptions, "model")?.currentValue;
  const variants = (setup.models?.availableModels ?? []).map((m) => m?.modelId);
  if (typeof model !== "string") return thoughtLevel(effort, listed);
  const own = listed.filter((l) => variants.includes(`${model}-${l}`));
  if (own.length) return thoughtLevel(effort, own);
  // A model listed on its own, at no level (`gpt-oss-120b-medium`), runs at its one fixed level:
  // nothing is sent, so the session keeps the level it has.
  if (variants.includes(model)) {
    const current = findOption(setup.configOptions, "thought_level")?.currentValue;
    return typeof current === "string" ? current : undefined;
  }
  return thoughtLevel(effort, listed);
}

export function thoughtLevel(
  effort: ReasoningEffort,
  listed: readonly string[],
): string | undefined {
  const want: Level = effort === "minimal" ? "low" : effort;
  if (listed.includes(want)) return want;
  const at = LEVELS.indexOf(want);
  for (let i = at - 1; i >= 0; i--) if (listed.includes(LEVELS[i] as Level)) return LEVELS[i];
  for (let i = at + 1; i < LEVELS.length; i++) {
    if (listed.includes(LEVELS[i] as Level)) return LEVELS[i];
  }
  return undefined;
}

/** "Default" leaves the model to the CLI's own setting, at the levels given. */
function defaultModel(efforts: readonly ReasoningEffort[]): ModelInfo {
  return {
    id: DEFAULT_MODEL_ID,
    label: "Default",
    description: CONFIGURED_MODEL,
    efforts: [...efforts],
    isDefault: true,
  };
}

/** Until a session has listed its models: Default, at the documented thinking levels. */
export function fallbackAntigravityModels(): ModelInfo[] {
  return [defaultModel(DOCUMENTED)];
}

/**
 * The models a session reports, after Default. The `model` config option names each model once
 * (`gemini-4-neon`); `models.availableModels` names each model at each thinking level it offers
 * (`gemini-4-neon-high`), which gives that model's efforts. A model with no such variants (one
 * fixed level, say) offers none. The session's current `thought_level` is the default effort
 * where the model offers it. Undefined when the session lists no models.
 */
export function antigravityModelInfos(setup: AcpSessionSetup): ModelInfo[] | undefined {
  const option = findOption(setup.configOptions, "model");
  const variants = (setup.models?.availableModels ?? [])
    .map((m) => m?.modelId)
    .filter((id): id is string => typeof id === "string" && !!id);
  const models = option
    ? optionValues(option).map((v) => ({ id: v.value, name: v.name, description: v.description }))
    : variants.map((id) => ({ id, name: undefined, description: undefined }));
  if (!models.length) return undefined;
  const thought = findOption(setup.configOptions, "thought_level");
  const levels = thought
    ? optionValues(thought)
        .map((v) => v.value)
        .filter(isLevel)
    : [];
  const current =
    typeof thought?.currentValue === "string" && isLevel(thought.currentValue)
      ? thought.currentValue
      : undefined;
  const seen = new Set<string>();
  const out: ModelInfo[] = [defaultModel(levels.length ? levels : DOCUMENTED)];
  for (const m of models) {
    if (!m.id || m.id === DEFAULT_MODEL_ID || seen.has(m.id)) continue;
    seen.add(m.id);
    const efforts = option ? LEVELS.filter((l) => variants.includes(`${m.id}-${l}`)) : [];
    out.push({
      id: m.id,
      label: m.name || m.id,
      ...(m.description ? { description: m.description } : {}),
      efforts,
      ...(current && efforts.includes(current) ? { defaultEffort: current } : {}),
    });
  }
  return out;
}
