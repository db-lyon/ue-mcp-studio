// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { keepInView } from "./keepInView";

function box(left: number, width: number): HTMLElement {
  const el = document.createElement("span");
  el.getBoundingClientRect = () => ({ left, right: left + width, width, top: 0, bottom: 10, height: 10, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
  return el;
}

afterEach(() => Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 0 }));

describe("keeping a tooltip inside a narrow docked window", () => {
  it("pushes one that runs off the left edge back in, and one off the right edge back in", () => {
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 540 });
    const left = box(-90, 330);
    keepInView(left);
    expect(left.style.translate).toBe("98px 0");
    const right = box(400, 300);
    keepInView(right);
    expect(right.style.translate).toBe("-168px 0");
  });

  it("leaves one that already fits, or is hidden, where it is", () => {
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 540 });
    const fits = box(100, 200);
    keepInView(fits);
    expect(fits.style.translate).toBe("");
    const hidden = box(0, 0);
    keepInView(hidden);
    expect(hidden.style.translate).toBe("");
  });
});
