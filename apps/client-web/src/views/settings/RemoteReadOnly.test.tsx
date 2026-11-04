// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { REMOTE_CHANGE_NOTE, RemoteReadOnly } from "./RemoteReadOnly";
import { KeyForm, SignInForm } from "../ModelPicker";

const win = window as unknown as { __studioRemotePage?: boolean };

afterEach(() => {
  cleanup();
  delete win.__studioRemotePage;
  vi.unstubAllGlobals();
});

describe("settings a paired browser may only read", () => {
  it("are shown disabled under the note in a paired browser", () => {
    render(<RemoteReadOnly remote><button>Save</button><input aria-label="Gateway" /></RemoteReadOnly>);
    expect(screen.getByText(REMOTE_CHANGE_NOTE)).toBeTruthy();
    expect((screen.getByRole("group") as HTMLFieldSetElement).disabled).toBe(true);
    expect(screen.getByText("Save").closest("fieldset")?.disabled).toBe(true);
  });

  it("are untouched on the computer", () => {
    render(<RemoteReadOnly remote={false}><button>Save</button></RemoteReadOnly>);
    expect(screen.queryByText(REMOTE_CHANGE_NOTE)).toBeNull();
    expect(screen.getByText("Save").closest("fieldset")).toBeNull();
  });

  it("offer no API key field and no sign-in in a paired browser", () => {
    const fetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    win.__studioRemotePage = true;
    render(<><KeyForm provider="anthropic" onSaved={() => {}} /><SignInForm id="chatgpt" onDone={() => {}} /></>);
    expect(screen.getAllByText(REMOTE_CHANGE_NOTE)).toHaveLength(2);
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.querySelector("input")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
