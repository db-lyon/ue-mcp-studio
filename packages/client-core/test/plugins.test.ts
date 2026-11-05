import { describe, expect, it } from "vitest";
import { catalogDetails } from "../src/index.js";

describe("catalogDetails", () => {
  it("shows the readme when there is one", () => {
    expect(catalogDetails({ readme: "# Meshy\n\nText to mesh.", description: "Meshes." })).toBe("# Meshy\n\nText to mesh.");
  });

  it("falls back to the description when the registry sends an empty readme", () => {
    // plugins.ue-mcp.com/api/plugins sends readme: "" for a plugin without one.
    expect(catalogDetails({ readme: "", description: "Generate a model with Meshy." })).toBe("Generate a model with Meshy.");
    expect(catalogDetails({ readme: "  \r\n", description: "Generate a model with Meshy." })).toBe("Generate a model with Meshy.");
    expect(catalogDetails({ description: "Generate a model with Meshy." })).toBe("Generate a model with Meshy.");
  });

  it("says so when there is neither", () => {
    expect(catalogDetails({})).toBe("No description.");
    expect(catalogDetails({ readme: "", description: "" })).toBe("No description.");
  });
});
