/**
 * Reports from the panel, filed as GitHub issues on Studio's tracker. They go
 * through ue-mcp's feedback endpoint, which opens the issue as the ue-mcp bot,
 * so the user needs no GitHub account in the panel. When the endpoint cannot
 * take it, the report comes back as a prefilled new-issue link instead, so
 * nothing the user wrote is lost.
 */
import * as os from "node:os";
import type { FeedbackReport, FeedbackResult } from "@ue-mcp-studio/shared";

export const FEEDBACK_ENDPOINT = process.env.UE_MCP_FEEDBACK_ENDPOINT || "https://feedback.ue-mcp.com/";
export const STUDIO_REPO = "db-lyon/ue-mcp-studio";
const LABEL = { problem: "bug", idea: "enhancement" } as const;
/** GitHub refuses new-issue links much longer than this. */
const MAX_LINK = 7500;

/** What is installed, for a report that includes it. Never keys, paths or project names. */
export interface Environment {
  studio: string;
  plugin: string | null;
  ueMcp: string;
  engine: string | null;
  model: string;
  route: string | null;
}

export function issueBody(r: FeedbackReport, env: Environment | null): string {
  const parts = [r.description.trim()];
  if (env) {
    parts.push(
      [
        "### Environment",
        `- Studio ${env.studio}`,
        `- Editor plugin ${env.plugin ?? "not in the project"}`,
        `- ue-mcp ${env.ueMcp}`,
        `- Unreal Engine ${env.engine ?? "unknown"}`,
        `- ${os.type()} ${os.release()}`,
        `- Model ${env.model}${env.route ? ` via ${env.route}` : ""}`,
      ].join("\n"),
    );
  }
  parts.push("_Filed from the Studio panel._");
  return parts.join("\n\n");
}

/** A prefilled new-issue page with the same report, shortened to fit a link. */
export function issueLink(title: string, body: string, labels: string[]): string {
  const make = (b: string) =>
    `https://github.com/${STUDIO_REPO}/issues/new?${new URLSearchParams({ title, body: b, labels: labels.join(",") })}`;
  let link = make(body);
  for (let cut = body.length; link.length > MAX_LINK && cut > 0; cut -= 500) link = make(`${body.slice(0, cut)}\n\n(shortened)`);
  return link;
}

export function validate(r: Partial<FeedbackReport>): string | null {
  if (r.kind !== "problem" && r.kind !== "idea") return "kind must be problem or idea";
  if (typeof r.title !== "string" || r.title.trim().length < 5) return "Give it a title of at least 5 characters.";
  if (r.title.trim().length > 200) return "Keep the title under 200 characters.";
  if (typeof r.description !== "string" || r.description.trim().length < 20) return "Describe it in at least 20 characters.";
  if (r.description.length > 50_000) return "The description is too long.";
  return null;
}

/** File the report, or say where the user can finish it themselves. */
export async function submitFeedback(r: FeedbackReport, env: Environment | null, fetchImpl: typeof fetch = fetch): Promise<FeedbackResult> {
  const title = r.title.trim();
  const body = issueBody(r, r.includeEnvironment ? env : null);
  const labels = [LABEL[r.kind], "from-studio"];
  const fallback = (reason: string): FeedbackResult => ({ filed: false, reason, link: issueLink(title, body, labels) });
  let res: Response;
  try {
    res = await fetchImpl(FEEDBACK_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ title, body, labels, repo: STUDIO_REPO }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return fallback("The feedback service could not be reached.");
  }
  const j = (await res.json().catch(() => null)) as { ok?: boolean; url?: string; number?: number; error?: string; code?: string } | null;
  if (res.ok && j?.url && j.number) return { filed: true, url: j.url, number: j.number };
  if (j?.code === "rate_limited") return fallback("Too many reports from here for now.");
  return fallback(j?.error ?? `The feedback service answered ${res.status}.`);
}
