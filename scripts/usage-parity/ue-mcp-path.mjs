/**
 * Where the ue-mcp package the agent depends on is installed. npm hoists it to
 * the repo's node_modules, or keeps it under apps/agent/node_modules when
 * versions conflict, so it is found the way Node resolves a package: the
 * nearest node_modules/ue-mcp from apps/agent upward.
 */
import fs from "node:fs";
import path from "node:path";

/** The ue-mcp package folder for the agent in this repo; throws naming every place it looked. */
export function ueMcpPackageDir(repo) {
  const looked = [];
  // apps/agent, apps, then the repo itself: never a folder above the repo.
  for (let dir = path.join(repo, "apps", "agent"); !path.relative(repo, dir).startsWith(".."); dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", "ue-mcp");
    looked.push(candidate);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.dirname(dir) === dir) break;
  }
  throw new Error(`ue-mcp is not installed: run npm ci. Looked in ${looked.join(", ")}`);
}
