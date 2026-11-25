import { CURATION_CARD_PREFIX, CURATION_PATHS, CurationPath } from "@codeden/contracts";
import type { GithubService } from "../github/github-service";
import type { CurationPort, CurationSnapshot } from "./curation";

export function githubCuration(github: GithubService): CurationPort {
  return {
    curationSnapshot(projectId) {
      const { owner, repo, defaultBranch } = github.githubRepo(projectId);
      return github.client.run(async (o) => {
        const location = { owner, repo };
        const sha = (await o.rest.git.getRef({ ...location, ref: `heads/${defaultBranch}` })).data
          .object.sha;
        const { tree } = (await o.rest.git.getCommit({ ...location, commit_sha: sha })).data;
        const files: CurationSnapshot["files"] = {};
        const root = (await o.rest.git.getTree({ ...location, tree_sha: tree.sha })).data.tree;
        const folder = root.find(({ path, type }) => path === ".codeden" && type === "tree");
        const nested = folder?.sha
          ? (await o.rest.git.getTree({ ...location, tree_sha: folder.sha })).data.tree
          : [];
        for (const path of CURATION_PATHS) {
          const entry =
            path === "AGENTS.md"
              ? root.find((entry) => entry.path === path)
              : nested.find((entry) => entry.path === "VISION.md");
          if (entry?.mode !== "100644" || !entry.sha || (entry.size ?? Infinity) > 32_768) continue;
          const blob = (await o.rest.git.getBlob({ ...location, file_sha: entry.sha })).data;
          if (blob.encoding !== "base64") continue;
          const bytes = Buffer.from(blob.content, "base64");
          const text = bytes.toString("utf8");
          if (Buffer.from(text).equals(bytes)) files[path] = text;
        }
        return { sha, files };
      });
    },

    async publishCuration(projectId, baseSha, cardId, files) {
      const { owner, repo, defaultBranch } = github.githubRepo(projectId);
      const suffix = cardId.slice(CURATION_CARD_PREFIX.length);
      if (!cardId.startsWith(CURATION_CARD_PREFIX) || !/^[a-f0-9]{64}$/.test(suffix)) {
        throw new Error("Invalid curation card");
      }
      const branch = `codeden/curation-${suffix}`;
      const result = await github.client.run(async (o) => {
        const location = { owner, repo };
        const head = async () =>
          (await o.rest.git.getRef({ ...location, ref: `heads/${defaultBranch}` })).data.object.sha;
        if ((await head()) !== baseSha) return null;
        const parent = (await o.rest.git.getCommit({ ...location, commit_sha: baseSha })).data;
        const tree = Object.entries(files).map(([path, content]) => ({
          path: CurationPath.parse(path),
          type: "blob" as const,
          mode: "100644" as const,
          content,
        }));
        if (!tree.length) throw new Error("Empty curation patch");
        const next = (
          await o.rest.git.createTree({ ...location, base_tree: parent.tree.sha, tree })
        ).data.sha;
        const ref = `heads/${branch}`;
        let existing: string | undefined;
        try {
          existing = (await o.rest.git.getRef({ ...location, ref })).data.object.sha;
        } catch (error) {
          if (!(error instanceof Error && "status" in error && error.status === 404)) throw error;
        }
        if (existing) {
          const commit = (await o.rest.git.getCommit({ ...location, commit_sha: existing })).data;
          if (
            commit.tree.sha !== next ||
            commit.parents.length !== 1 ||
            commit.parents[0]?.sha !== baseSha
          )
            throw new Error("Curation branch contents differ");
        } else {
          if ((await head()) !== baseSha) return null;
          const commit = (
            await o.rest.git.createCommit({
              ...location,
              message: "docs: curate project instructions",
              tree: next,
              parents: [baseSha],
            })
          ).data.sha;
          await o.rest.git.createRef({ ...location, ref: `refs/${ref}`, sha: commit });
        }
        if ((await head()) !== baseSha) return null;
        const prs = (
          await o.rest.pulls.list({
            ...location,
            head: `${owner}:${branch}`,
            base: defaultBranch,
            state: "all",
            per_page: 1,
          })
        ).data;
        const pr =
          prs[0] ??
          (
            await o.rest.pulls.create({
              ...location,
              head: branch,
              base: defaultBranch,
              title: "Curate project instructions",
              body: `The PM reviewed and the owner approved this exact instruction diff at base \`${baseSha}\`. CodeDen did not change the project checkout or merge this pull request.`,
              draft: true,
            })
          ).data;
        return {
          number: pr.number,
          title: pr.title,
          url: pr.html_url,
          state: pr.state === "open" ? ("open" as const) : ("closed" as const),
        };
      });
      if (result) github.sync.soon(projectId);
      return result;
    },
  };
}
