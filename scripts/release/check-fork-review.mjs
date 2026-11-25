import { execFileSync } from "node:child_process";
import { FORK_RELEASE_REPOSITORY } from "../../packages/contracts/src/fork-build.ts";

const { GITHUB_REPOSITORY, GITHUB_SHA, REVIEW_PR } = process.env;
if (
  GITHUB_REPOSITORY !== FORK_RELEASE_REPOSITORY ||
  !/^[0-9a-f]{40}$/.test(GITHUB_SHA ?? "") ||
  !/^[1-9]\d*$/.test(REVIEW_PR ?? "")
) {
  throw new Error("A fork repository, checkout SHA and review PR are required");
}
if (execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== GITHUB_SHA) {
  throw new Error("The checkout does not match the dispatched SHA");
}

const api = (...args) => JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8" }));
const resource = `repos/${FORK_RELEASE_REPOSITORY}/pulls/${REVIEW_PR}`;
const pr = api(resource);
if (
  pr.head.sha !== GITHUB_SHA ||
  pr.head.repo?.full_name !== GITHUB_REPOSITORY ||
  pr.base.ref !== "codeden/build-20261125b3" ||
  pr.base.repo.full_name !== GITHUB_REPOSITORY ||
  pr.draft ||
  (pr.state !== "open" && !pr.merged)
) {
  throw new Error("The Build C review PR does not identify this release candidate");
}

const decisions = new Map();
for (const review of api("--paginate", "--slurp", `${resource}/reviews?per_page=100`).flat()) {
  if (
    !review.user ||
    review.user.id === pr.user.id ||
    !["OWNER", "MEMBER", "COLLABORATOR"].includes(review.author_association)
  )
    continue;
  if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) {
    decisions.set(review.user.id, review);
  }
}
const active = [...decisions.values()];
if (
  active.some((review) => review.state === "CHANGES_REQUESTED") ||
  !active.some((review) => review.state === "APPROVED" && review.commit_id === GITHUB_SHA)
) {
  throw new Error("Build C has no clean authorized review for this exact SHA");
}
