import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerInvokeCommand, resetInvokeCommands } from "./helpers/tauriMock";
import { initScreenPen } from "../src/screenPen";

describe("screen pen entry", () => {
  let dispose: () => void;
  beforeEach(() => {
    document.body.innerHTML = '<button id="btn-screen-pen">펜</button><span id="screen-pen-status"></span>';
    resetInvokeCommands();
    dispose = initScreenPen();
  });
  afterEach(() => { dispose(); resetInvokeCommands(); });
  it("opens once while pending and does not modify a draft or clipboard", async () => {
    let finish!: () => void;
    const open = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    registerInvokeCommand("open_screen_pen", open);
    const button = document.querySelector("button")!;
    button.click(); button.click();
    expect(open).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);
    finish();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(document.querySelector("span")!.textContent).toBe("");
  });
  it("explains a failed open and lets the user retry", async () => {
    const open = vi.fn().mockRejectedValueOnce(new Error("화면 펜을 열지 못했습니다.")).mockResolvedValue(undefined);
    registerInvokeCommand("open_screen_pen", open);
    const button = document.querySelector("button")!;
    button.click();
    await vi.waitFor(() => expect(document.querySelector("span")!.textContent).toContain("열지 못했습니다"));
    expect(button.disabled).toBe(false);
    button.click();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(open).toHaveBeenCalledTimes(2);
    expect(document.querySelector("span")!.textContent).toBe("");
  });
  it("ignores a late failure after the entry has been disposed", async () => {
    let fail!: (error: Error) => void;
    registerInvokeCommand("open_screen_pen", () => new Promise((_, reject) => { fail = reject; }));
    document.querySelector("button")!.click(); dispose();
    fail(new Error("old failure"));
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector("span")!.textContent).toBe("");
  });
});
