import { describe, expect, it, vi } from "vitest";
import { issueBody, issueLink, submitFeedback, validate, STUDIO_REPO } from "../src/feedback.js";

const report = { kind: "problem" as const, title: "Changes panel is blank", description: "Clicking the Git chip opens an empty panel.", includeEnvironment: true };
const env = { studio: "0.1.0-beta.27", plugin: "0.1.0-beta.27", ueMcp: "1.4.0-beta.3", engine: "5.8", model: "claude-opus-5-5", route: "key" };

describe("Studio feedback", () => {
  it("adds what is installed only when the user includes it", () => {
    expect(issueBody(report, env)).toMatch(/### Environment\n- Studio 0.1.0-beta.27\n- Editor plugin 0.1.0-beta.27\n- ue-mcp 1.4.0-beta.3\n- Unreal Engine 5.8/);
    expect(issueBody(report, null)).not.toMatch(/Environment/);
  });

  it("asks for a real title and description", () => {
    expect(validate({ ...report, title: "x" })).toMatch(/title/);
    expect(validate({ ...report, description: "short" })).toMatch(/at least 20/);
    expect(validate({ ...report, kind: "rant" as never })).toMatch(/kind/);
    expect(validate(report)).toBeNull();
  });

  it("files it on Studio's tracker as a bug or an enhancement", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, url: "https://github.com/db-lyon/ue-mcp-studio/issues/9", number: 9 }), { status: 201 }));
    expect(await submitFeedback(report, env, fetchImpl as never)).toEqual({ filed: true, url: "https://github.com/db-lyon/ue-mcp-studio/issues/9", number: 9 });
    const sent = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(sent).toMatchObject({ repo: STUDIO_REPO, labels: ["bug", "from-studio"], title: "Changes panel is blank" });
    await submitFeedback({ ...report, kind: "idea" }, env, fetchImpl as never);
    expect(JSON.parse(String((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body)).labels).toEqual(["enhancement", "from-studio"]);
  });

  it("hands back a prefilled issue link when the service cannot file it", async () => {
    const refused = vi.fn(async () => new Response(JSON.stringify({ error: "db-lyon/ue-mcp-studio refused the issue.", code: "repo_unavailable" }), { status: 409 }));
    const r = await submitFeedback(report, env, refused as never);
    expect(r).toMatchObject({ filed: false, reason: "db-lyon/ue-mcp-studio refused the issue." });
    expect(r.filed === false && new URL(r.link).searchParams.get("title")).toBe("Changes panel is blank");
    const down = vi.fn(async () => { throw new Error("offline"); });
    expect(await submitFeedback(report, env, down as never)).toMatchObject({ filed: false, reason: /could not be reached/ });
  });

  it("keeps the link short enough for GitHub", () => {
    expect(issueLink("t", "x".repeat(40_000), ["bug"]).length).toBeLessThanOrEqual(7500);
  });
});
