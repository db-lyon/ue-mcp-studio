/** The account sign-in's shared rules: which logins get the @, the methods list, the last method, the email and code checks. */
import { describe, expect, it } from "vitest";
import { accountHandle, accountMethods, isEmailAddress, isEmailCode, isLastMethod, waitText } from "../src/index.js";

describe("accountHandle", () => {
  it("the @ only when the account view says the login is the GitHub login", () => {
    expect(accountHandle("octocat", "octocat")).toBe("@octocat");
    expect(accountHandle("dev@example.com", null)).toBe("dev@example.com");
    expect(accountHandle("cat@example.com", "octocat")).toBe("cat@example.com");
  });

  it("never from the login alone: unknown GitHub shows the login plain", () => {
    expect(accountHandle("octocat")).toBe("octocat");
    expect(accountHandle("dev@example.com")).toBe("dev@example.com");
  });
});

describe("the account's ways to sign in", () => {
  it("lists email and GitHub, none for an agent that sent neither", () => {
    expect(accountMethods({ email: "a@b.co", github: null })).toEqual([
      { kind: "email", label: "Email", value: "a@b.co" },
      { kind: "github", label: "GitHub", value: null },
    ]);
    expect(accountMethods({})).toEqual([]);
  });

  it("the last one left cannot go", () => {
    expect(isLastMethod({ email: "a@b.co", github: null }, "email")).toBe(true);
    expect(isLastMethod({ email: null, github: "octocat" }, "github")).toBe(true);
    expect(isLastMethod({ email: "a@b.co", github: "octocat" }, "github")).toBe(false);
  });
});

describe("checks", () => {
  it("email addresses and 6-digit codes", () => {
    for (const ok of ["a@b.co", " dev@example.com ", "first.last+tag@sub.example.org"]) expect(isEmailAddress(ok), ok).toBe(true);
    for (const bad of ["", "a", "a@", "@b.co", "a@b", "a b@c.co", "a@b@c.co", 1, null]) expect(isEmailAddress(bad), String(bad)).toBe(false);
    expect(isEmailCode("123456")).toBe(true);
    for (const bad of ["12345", "1234567", "12a456", 123456]) expect(isEmailCode(bad), String(bad)).toBe(false);
  });

  it("the wait in seconds and minutes", () => {
    expect(waitText(42)).toBe("42 s");
    expect(waitText(65)).toBe("1 min 5 s");
    expect(waitText(600)).toBe("10 min");
  });
});
