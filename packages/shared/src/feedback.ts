/**
 * A feedback report as a prefilled new-issue page on Studio's tracker: the
 * agent's fallback when the feedback service cannot take a report, and the
 * clients' when the report never reached the agent at all.
 */

export const FEEDBACK_REPO = "db-lyon/ue-mcp-studio";
/** The labels a report's kind files under, besides from-studio. */
export const FEEDBACK_LABEL = { problem: "bug", idea: "enhancement" } as const;
/** The last line of every report's body. */
export const FEEDBACK_FOOTER = "_Filed from the Studio panel._";
/** GitHub refuses new-issue links much longer than this. */
const MAX_LINK = 7500;

/** A prefilled new-issue page with the report, shortened to fit a link. */
export function feedbackIssueLink(title: string, body: string, labels: string[]): string {
  const make = (b: string) => `https://github.com/${FEEDBACK_REPO}/issues/new?${new URLSearchParams({ title, body: b, labels: labels.join(",") })}`;
  let link = make(body);
  for (let cut = body.length; link.length > MAX_LINK && cut > 0; cut -= 500) link = make(`${body.slice(0, cut)}\n\n(shortened)`);
  return link;
}

/**
 * The same report as a link, made by a client when sending failed. `environment`
 * is the agent's preview of what it would add (which ends with the footer),
 * or null to leave it out.
 */
export function feedbackLinkOf(r: { kind: "problem" | "idea"; title: string; description: string }, environment: string | null): string {
  const body = [r.description.trim(), environment?.trim() || FEEDBACK_FOOTER].filter(Boolean).join("\n\n");
  return feedbackIssueLink(r.title.trim(), body, [FEEDBACK_LABEL[r.kind], "from-studio"]);
}
