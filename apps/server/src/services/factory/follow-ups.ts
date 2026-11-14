import {
  type FactoryFollowUp,
  type FactoryItem,
  FOLLOW_UP_LABEL,
  type GitHubIssueRef,
  type Project,
  sameFollowUpTitle,
} from "@codeden/contracts";
import { badRequest, errorMessage } from "../errors";
import type { FactoryContext } from "./context";
import { FACTORY_LABEL } from "./intake";
import { FOLLOW_UPS_DUE } from "./store";

/**
 * Review follow-ups (§10.1, Review and revise): the reviewer's non-blocking findings. They
 * never fail a merge check or start a revise round. When the pull request merges, the item keeps
 * the follow-ups of the verdict on record; the dark factory then files each as an issue (labelled
 * and linked to the PR), the software factory lists them on the item to file with "File issue".
 * A follow-up whose title matches an open issue is linked to that issue instead of filed again.
 */

/** How long the dark factory keeps retrying follow-ups GitHub didn't take; then they wait on the item. */
export const FOLLOW_UPS_RETRY_MS = 60 * 60_000;

/** What a merge records on the item: the verdict's follow-ups, and whether they wait to be filed. */
export function followUpsAtMerge(
  item: FactoryItem,
  at: string,
): Pick<FactoryItem, "followUps" | "nudges"> {
  const followUps =
    item.followUps.length > 0
      ? item.followUps
      : (item.review?.followUps ?? []).map((f): FactoryFollowUp => ({ ...f, issue: null }));
  const due = followUps.some((f) => !f.issue);
  return {
    followUps,
    nudges: due
      ? { ...item.nudges, [FOLLOW_UPS_DUE]: item.nudges[FOLLOW_UPS_DUE] ?? at }
      : item.nudges,
  };
}

/** The issue's text: the follow-up, the pull request it came from, and that it didn't block. */
function issueBody(item: FactoryItem, f: FactoryFollowUp): string {
  const pr = item.pr ? `#${item.pr.number} (${item.pr.url})` : "its pull request";
  const facts = [
    f.severity ? `Severity: ${f.severity}` : "",
    f.area ? `Area: ${f.area}` : "",
  ].filter(Boolean);
  return [
    f.title,
    "",
    `A follow-up from the independent review of ${pr}, "${item.title}". The reviewer approved the change; this didn't block the merge.`,
    ...(facts.length ? ["", facts.join(" · ")] : []),
    "",
    "_Filed by the CodeDen factory from a review follow-up._",
    `<!-- codeden:factory follow-up item=${item.id} -->`,
  ].join("\n");
}

/**
 * File one follow-up: link it to an open issue with the same title (or one filed earlier in the
 * same pass, in `filed`), otherwise create the issue. Records the issue on the item.
 */
async function fileOne(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
  index: number,
  filed: GitHubIssueRef[] = [],
): Promise<GitHubIssueRef> {
  const f = item.followUps[index] as FactoryFollowUp;
  if (f.issue) return f.issue;
  const open = ctx.github.openIssues(project.id).find((i) => sameFollowUpTitle(i.title, f.title));
  const issue: GitHubIssueRef =
    filed.find((i) => sameFollowUpTitle(i.title ?? "", f.title)) ??
    (open
      ? { number: open.number, url: open.url, title: open.title }
      : await ctx.github.createIssue(project.id, {
          title: f.title,
          body: issueBody(item, f),
          labels: [FACTORY_LABEL, FOLLOW_UP_LABEL],
        }));
  filed.push({ ...issue, title: issue.title ?? f.title });
  ctx.store.updateItem(
    item.id,
    (i) => ({
      ...i,
      followUps: i.followUps.map((x, n) => (n === index ? { ...x, issue } : x)),
    }),
    { touch: false },
  );
  return issue;
}

/**
 * The loop's step for merged work: in the dark factory, file the follow-ups that wait (retried
 * on the next ticks while GitHub doesn't take them, for up to `FOLLOW_UPS_RETRY_MS`). In the
 * software factory they wait on the item for a person's "File issue".
 */
export async function fileDueFollowUps(ctx: FactoryContext, project: Project): Promise<void> {
  const filed: GitHubIssueRef[] = [];
  for (const item of ctx.store.itemsWithFollowUpsDue(project.id)) {
    const since = Date.parse(item.nudges[FOLLOW_UPS_DUE] ?? "");
    let failed = false;
    if (project.autonomyMode === "dark_factory") {
      for (const [index, f] of item.followUps.entries()) {
        if (f.issue) continue;
        try {
          await fileOne(ctx, project, ctx.store.item(item.id) ?? item, index, filed);
        } catch (error) {
          failed = true;
          ctx.log?.(`factory: filing a follow-up of ${item.id}: ${errorMessage(error)}`);
        }
      }
    }
    if (failed && ctx.now().getTime() - since < FOLLOW_UPS_RETRY_MS) continue;
    ctx.store.updateItem(
      item.id,
      (i) => {
        const { [FOLLOW_UPS_DUE]: _due, ...nudges } = i.nudges;
        return { ...i, nudges };
      },
      { touch: false },
    );
  }
}

/** "File issue" on the item page: file one follow-up of a merged item (once). */
export async function fileFollowUp(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
  index: number,
): Promise<FactoryItem> {
  if (!item.followUps[index]) {
    throw badRequest(
      item.followUps.length === 0
        ? "This item has no follow-ups to file: they are kept once its pull request merges"
        : `No follow-up ${index}: the item has ${item.followUps.length}`,
      "no_follow_up",
    );
  }
  await fileOne(ctx, project, item, index);
  return ctx.store.item(item.id) ?? item;
}
