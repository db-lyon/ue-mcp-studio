import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import type { Transport } from "@ue-mcp-studio/client-core";
import { ReplyMarkdown } from "../src/chat/ReplyMarkdown";
import { fakeApi, fakeProject, renderInProject, settle } from "./helpers";

describe("images in a reply on the phone", () => {
  it("loads a project image through Studio and shows it, its alt text until then", async () => {
    const asked: string[] = [];
    const transport: Transport = async (_method, path) => {
      asked.push(path);
      return { status: 200, headers: { "content-type": "image/jpeg" }, body: new Response(new Uint8Array([1, 2, 3])).body };
    };
    renderInProject(<ReplyMarkdown text={"![Step 2: enemy meets the player](Saved/MCPObservations/run/captures/step02.jpg)"} />, fakeApi(), fakeProject(transport).project);
    await settle();
    expect(asked).toEqual(["/v1/ext/studio/files/image?path=Saved%2FMCPObservations%2Frun%2Fcaptures%2Fstep02.jpg"]);
    const img = screen.getByLabelText("Step 2: enemy meets the player") as HTMLImageElement;
    expect(img.getAttribute("src") ?? img.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/jpeg;base64,AQID/);
  });
});
