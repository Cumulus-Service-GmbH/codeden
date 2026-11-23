import { z } from "zod";
import { ChecklistItem } from "./checklist";
import { AutonomyLevel, Id, ProviderId, ReasoningEffort } from "./common";
import { TokenSaverLevel } from "./token-saver";
import { ConflictDecision, WorkKey } from "./work";

/** Input for the PM tool that opens an agent session. */
export const PmStartSessionInput = z.object({
  prompt: z
    .string()
    .min(1)
    .max(50_000)
    .describe(
      "The brief for the agent: goal, context, acceptance criteria, and the decisions you already made (defaults, scope, whether to open a pull request), so the agent doesn't have to ask",
    ),
  autonomy: AutonomyLevel.optional(),
  purpose: z.string().trim().min(1).max(300),
  checklistItemId: ChecklistItem.shape.id
    .optional()
    .describe("The approved checklist item for this work, when applicable"),
  workKey: WorkKey.optional(),
  scope: z
    .object({ paths: z.array(z.string()).optional(), area: z.string().optional() })
    .optional(),
  title: z.string().trim().min(1).max(200).optional(),
  issueNumber: z.int().positive().optional(),
  provider: ProviderId.optional(),
  model: z.string().min(1).optional(),
  effort: ReasoningEffort.optional(),
  /** Overrides the parent session's token saver level. */
  tokenSaver: TokenSaverLevel.optional(),
  conflict: ConflictDecision.optional(),
  reportTo: z
    .enum(["orchestrator"])
    .optional()
    .describe(
      "'orchestrator' when the orchestrator passed this work on: its finish or failure also reaches the orchestrator, so it can tell the user",
    ),
});

/** Input for changing the autonomy of an existing agent session. */
export const SetSessionAutonomyInput = z.object({
  sessionId: Id,
  autonomy: AutonomyLevel,
  reason: z.string().trim().min(1).max(1000),
});

/** Audit record for a PM's successful autonomy change. */
export const SessionAutonomyChanged = SetSessionAutonomyInput.omit({ sessionId: true }).extend({
  previous: AutonomyLevel,
  changedBy: Id,
});
export type SessionAutonomyChanged = z.infer<typeof SessionAutonomyChanged>;
