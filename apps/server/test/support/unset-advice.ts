/**
 * Advice to unset CodeDen's internal `CODEDEN_*` variables before running tests (#422). Agent
 * sessions don't inherit them (#191, #210; `packages/providers/test/agent-env.test.ts` keeps it
 * so), and checking for them stalled agents on an approval in the dark factory.
 */
export const UNSET_ADVICE =
  /\b(unset|clear|remove|delete|strip)\b[^.\n]{0,80}CODEDEN_|env\s+-u\s+CODEDEN_|Remove-Item\s+Env:\\?CODEDEN/i;
