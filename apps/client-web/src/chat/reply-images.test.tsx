// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ReplyMarkdown } from "./ReplyMarkdown";

afterEach(cleanup);

describe("images in a reply", () => {
  it("shows a project image through Studio, a Windows path included, and opens it full size", () => {
    render(<ReplyMarkdown text={"![Step 2: enemy meets the player](Saved/MCPObservations/run/captures/step02_client0_1.jpg)\n\n![Step 4](C:/Users/me/Vale/Saved/step04.jpg)"} />);
    const step2 = screen.getByAltText("Step 2: enemy meets the player") as HTMLImageElement;
    expect(step2.getAttribute("src")).toBe("/v1/ext/studio/files/image?path=Saved%2FMCPObservations%2Frun%2Fcaptures%2Fstep02_client0_1.jpg");
    expect(step2.closest("a")?.getAttribute("href")).toBe(step2.getAttribute("src"));
    expect((screen.getByAltText("Step 4") as HTMLImageElement).getAttribute("src")).toBe("/v1/ext/studio/files/image?path=C%3A%2FUsers%2Fme%2FVale%2FSaved%2Fstep04.jpg");
  });

  it("leaves a web image as it is", () => {
    render(<ReplyMarkdown text={"![logo](https://example.com/logo.png)"} />);
    expect((screen.getByAltText("logo") as HTMLImageElement).getAttribute("src")).toBe("https://example.com/logo.png");
  });
});
