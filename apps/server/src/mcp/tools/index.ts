import type { AnyServerTool } from "../define";
import { askUser } from "./ask-user";
import {
  browserClick,
  browserEvaluate,
  browserLogs,
  browserNavigate,
  browserOpenDevServer,
  browserPress,
  browserSnapshot,
  browserType,
  browserWait,
} from "./browser";
import { browserDialog } from "./browser-dialog";
import { browserMouse } from "./browser-mouse";
import { browserScreenshot } from "./browser-screenshot";
import { browserSelect } from "./browser-select";
import { browserUpload } from "./browser-upload";
import { readChecklist, updateChecklistItem } from "./checklist";
import {
  confirmPlanApproval,
  executePlanStep,
  listDecisionCards,
  postGithubApproval,
  raiseGithubApproval,
  raisePlanApproval,
} from "./decisions";
import { factoryTools } from "./factory";
import { finish } from "./finish";
import { generateImage } from "./generate-image";
import { githubTools } from "./github";
import { orchestratorTools } from "./orchestrator";
import { mergePullRequest, resumeSession } from "./orchestrator/decision-actions";
import { pmTools } from "./pm";
import { reportProgress } from "./report-progress";
import { shareToChat } from "./share-to-chat";
import { suggestFollowups } from "./suggest-followups";
import { importTechDebt, listTechDebt, recordTechDebt } from "./tech-debt";
import { wakeupTools } from "./wakeups";

/** Every CodeDen tool, in the order agents see them. Add new tools here (one file each). */
export const allTools: AnyServerTool[] = [
  reportProgress,
  readChecklist,
  updateChecklistItem,
  askUser,
  shareToChat,
  suggestFollowups,
  finish,
  browserNavigate,
  browserSnapshot,
  browserClick,
  browserType,
  browserPress,
  browserMouse,
  browserSelect,
  browserUpload,
  browserDialog,
  browserScreenshot,
  browserLogs,
  browserWait,
  browserEvaluate,
  browserOpenDevServer,
  generateImage,
  listTechDebt,
  recordTechDebt,
  importTechDebt,
  raiseGithubApproval,
  raisePlanApproval,
  confirmPlanApproval,
  executePlanStep,
  listDecisionCards,
  postGithubApproval,
  ...orchestratorTools,
  mergePullRequest,
  resumeSession,
  ...pmTools,
  ...wakeupTools,
  ...githubTools,
  ...factoryTools,
];
