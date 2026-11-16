/**
 * Reports from the panel, filed as GitHub issues on Studio's tracker. They go
 * through ue-mcp's feedback endpoint, which opens the issue as the ue-mcp bot,
 * so the user needs no GitHub account in the panel. When the endpoint cannot
 * take it, the report comes back as a prefilled new-issue link instead, so
 * nothing the user wrote is lost.
 */
import * as os from "node:os";
import { FEEDBACK_FOOTER, FEEDBACK_LABEL, FEEDBACK_REPO, feedbackIssueLink, type FeedbackReport, type FeedbackResult } from "@ue-mcp-studio/shared";

export const FEEDBACK_ENDPOINT = process.env.UE_MCP_FEEDBACK_ENDPOINT || "https://feedback.ue-mcp.com/";
export const STUDIO_REPO = FEEDBACK_REPO;
const LABEL = FEEDBACK_LABEL;

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
  const description = (r.description ?? "").trim();
  const parts = description ? [description] : [];
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
  parts.push(FEEDBACK_FOOTER);
  return parts.join("\n\n");
}

/** A prefilled new-issue page with the same report, shortened to fit a link. */
export const issueLink = feedbackIssueLink;

/** Only what a report cannot be filed without: a kind and a title. No minimum lengths. */
export function validate(r: Partial<FeedbackReport>): string | null {
  if (r.kind !== "problem" && r.kind !== "idea") return "kind must be problem or idea";
  if (typeof r.title !== "string" || r.title.trim().length === 0) return "Give it a title.";
  if (r.description !== undefined && typeof r.description !== "string") return "The description must be text.";
  if ((r.description ?? "").length > 50_000) return "The description is too long.";
  return null;
}

/** The longest title an issue gets; a longer one goes whole at the top of the description. */
export const TITLE_MAX = 200;

/** A report whose title is too long for one: the title cut at a word, the whole of it leading the description. */
export function fitTitle(r: FeedbackReport): FeedbackReport {
  const title = r.title.trim();
  if (title.length <= TITLE_MAX) return r;
  const cut = title.slice(0, TITLE_MAX - 3).replace(/\s+\S*$/, "") || title.slice(0, TITLE_MAX - 3);
  return { ...r, title: `${cut}...`, description: [title, r.description ?? ""].filter(Boolean).join("\n\n") };
}

/** File the report, or say where the user can finish it themselves. */
export async function submitFeedback(given: FeedbackReport, env: Environment | null, fetchImpl: typeof fetch = fetch): Promise<FeedbackResult> {
  const r = fitTitle(given);
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
