// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BarProjectSwitch } from "./ProjectSwitch";

afterEach(cleanup);

describe("the wide bar's project switch", () => {
  it("names the open project and switches to every other one", () => {
    const onSwitch = vi.fn();
    render(<BarProjectSwitch name="Vale on NIMBA1" onSwitch={onSwitch} />);
    expect(screen.getByText("Vale on NIMBA1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Switch project: every project on your paired computers" }));
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });
});
