import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatBuildIdentity, showBuildInfo, type BuildInfo } from "../src/buildInfo";

const info: BuildInfo = {
  version: "0.3.0", revision: "c99594aaa5500dd5e1fef1397573e71fdeb76e47", dirty: false,
  channel: "release", builtAtUnixSeconds: 1792882800, buildNumber: "42.1",
};

describe("installed build identity", () => {
  beforeEach(() => { document.body.innerHTML = '<div id="app-version"></div><div id="app-build"></div>'; });
  it("distinguishes release, validation and modified development builds", () => {
    expect(formatBuildIdentity(info)).toBe("릴리스 빌드 · #42.1 · c99594a");
    expect(formatBuildIdentity({ ...info, channel: "validation" })).toContain("검증 빌드");
    expect(formatBuildIdentity({ ...info, channel: "development", buildNumber: null, dirty: true })).toBe("개발 빌드 · c99594a · 수정됨");
  });
  it("renders the running native version and build safely as text", async () => {
    const invoke = vi.fn().mockResolvedValue({ ...info, version: '<b>0.3.0</b>' });
    vi.stubGlobal("__TAURI__", { core: { invoke } });
    await showBuildInfo();
    expect(invoke).toHaveBeenCalledWith("get_build_info");
    expect(document.getElementById("app-version")!.textContent).toBe("v<b>0.3.0</b>");
    expect(document.querySelector("b")).toBeNull();
    expect(document.getElementById("app-build")!.textContent).toContain("#42.1 · c99594a");
  });
  it("shows an explicit failure instead of a stale hardcoded version", async () => {
    vi.stubGlobal("__TAURI__", { core: { invoke: vi.fn().mockRejectedValue(new Error("unavailable")) } });
    await showBuildInfo();
    expect(document.getElementById("app-version")!.textContent).toBe("버전 정보를 가져오지 못했습니다");
    expect(document.getElementById("app-build")!.textContent).toBe("");
  });
});
