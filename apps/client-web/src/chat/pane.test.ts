import { describe, expect, it } from "vitest";
import { chatPane } from "./pane";

describe("the narrow chat's pane", () => {
  it("shows an open session's conversation", () => {
    expect(chatPane("s1", true, 3)).toBe("conversation");
    expect(chatPane("s1", false, 0)).toBe("conversation");
  });

  it("shows the list when sessions exist and none is open", () => {
    expect(chatPane(null, true, 3)).toBe("list");
  });

  it("shows the list while it is still loading, so an empty list is not taken for no sessions", () => {
    expect(chatPane(null, false, 0)).toBe("list");
  });

  it("shows the empty conversation, where one starts, when there are no sessions", () => {
    expect(chatPane(null, true, 0)).toBe("conversation");
  });
});
