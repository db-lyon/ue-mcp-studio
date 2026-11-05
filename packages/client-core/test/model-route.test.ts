import { describe, expect, it } from "vitest";
import { CONNECT_ON_COMPUTER, lockedVia } from "../src/index.js";

describe("lockedVia", () => {
  it("says sign in or connect on the computer", () => {
    expect(lockedVia({ signIns: ["chatgpt"] }, false)).toBe("sign in");
    expect(lockedVia({ signIns: [] }, false)).toBe("connect");
  });
  it("sends a paired device to the computer, which alone can add a sign-in or a key", () => {
    expect(lockedVia({ signIns: ["chatgpt"] }, true)).toBe(CONNECT_ON_COMPUTER);
    expect(lockedVia({ signIns: [] }, true)).toBe("Connect on your computer");
  });
});
