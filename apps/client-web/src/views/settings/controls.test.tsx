// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Seg } from "./controls";

afterEach(cleanup);

describe("a choice with long names", () => {
  it("is marked seg-stack, never the page layout's stack class, so a wide panel keeps it inline", () => {
    const { container } = render(
      <Seg label="Starts" value="ask" onChange={() => {}} options={[{ id: "never", name: "Never" }, { id: "ask", name: "When you ask" }, { id: "split", name: "When work splits into independent parts" }]} />,
    );
    const seg = container.querySelector(".seg")!;
    expect(seg.classList.contains("seg-stack")).toBe(true);
    expect(seg.classList.contains("stack")).toBe(false);
  });
});
