// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LogsView, eventPayload } from "./Logs";
import type { DaemonState } from "../state";

const daemon = (events: DaemonState["events"]): DaemonState => ({ health: null, error: null, streaming: true, events, refresh: () => {} }) as unknown as DaemonState;
const ev = (id: number, type: string, data: Record<string, unknown>) => ({ id, type, at: new Date(Date.UTC(2026, 10, 3, 12, 0, id)).toISOString(), data });

describe("the event log", () => {
  afterEach(cleanup);

  it("lists events newest first, each with its time and type on one line and its payload under them", () => {
    render(<LogsView daemon={daemon([ev(1, "editor.connected", { port: 64666 }), ev(2, "studio.session.changed", { sessionId: "s1", status: "running" })])} />);
    const items = screen.getByRole("list", { name: "Events, newest first" }).querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0].querySelector(".log-type")?.textContent).toBe("studio.session.changed");
    expect(items[0].querySelector(".log-head time")).not.toBeNull();
    expect(items[0].querySelector(".log-data > summary")?.textContent).toBe('{"sessionId":"s1","status":"running"}');
    expect(items[1].querySelector(".log-type")?.textContent).toBe("editor.connected");
  });

  it("keeps the whole payload, indented, for when the row is opened", () => {
    render(<LogsView daemon={daemon([ev(1, "studio.transcript.added", { sessionId: "s1", entry: { kind: "note" } })])} />);
    expect(document.querySelector(".log-data > pre")?.textContent).toBe(JSON.stringify({ sessionId: "s1", entry: { kind: "note" } }, null, 2));
  });

  it("shows no payload block for an event without one", () => {
    render(<LogsView daemon={daemon([ev(1, "studio.remote.available", {})])} />);
    expect(eventPayload({}).line).toBe("{}");
    expect(eventPayload(null)).toEqual({ line: "", full: "" });
    expect(document.querySelectorAll(".log-event")).toHaveLength(1);
  });

  it("filters by type or payload", () => {
    render(<LogsView daemon={daemon([ev(1, "editor.connected", { port: 64666 }), ev(2, "studio.session.changed", { sessionId: "door" })])} />);
    fireEvent.change(screen.getByLabelText("Filter events"), { target: { value: "door" } });
    expect(document.querySelectorAll(".log-event")).toHaveLength(1);
    expect(document.querySelector(".log-type")?.textContent).toBe("studio.session.changed");
    fireEvent.change(screen.getByLabelText("Filter events"), { target: { value: "nothing" } });
    expect(screen.getByText("No events yet.")).toBeTruthy();
  });
});
