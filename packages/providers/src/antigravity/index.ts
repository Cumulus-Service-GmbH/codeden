/**
 * Antigravity CLI adapter: its ACP server (`agy acp --process-per-session`) driven by the
 * generic ACP client, plus discovery, its models and its thinking levels.
 */
export {
  ANTIGRAVITY_AGENT,
  ANTIGRAVITY_PROVIDER_ID,
  AntigravityAdapter,
  type AntigravityAdapterOptions,
} from "./adapter";
export {
  ANTIGRAVITY_INSTALL_COMMAND,
  ANTIGRAVITY_LOGIN_COMMAND,
  ANTIGRAVITY_MIN_VERSION,
  ANTIGRAVITY_UPGRADE_COMMAND,
  antigravityInstallCommand,
  antigravityTooOldMessage,
  detectAntigravity,
  isSupportedAntigravityVersion,
} from "./detect";
export {
  antigravityModelInfos,
  fallbackAntigravityModels,
  modelThoughtLevel,
  thoughtLevel,
} from "./models";
export {
  ANTIGRAVITY_ACP_ARGS,
  type AntigravityProbe,
  type AntigravityProbeReports,
  probeAntigravity,
} from "./probe";
