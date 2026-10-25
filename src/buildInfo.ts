export interface BuildInfo {
  version: string;
  revision: string | null;
  dirty: boolean;
  channel: "development" | "validation" | "release";
  builtAtUnixSeconds: number;
  buildNumber: string | null;
}

export function formatBuildIdentity(info: BuildInfo): string {
  const channel = { development: "개발 빌드", validation: "검증 빌드", release: "릴리스 빌드" }[info.channel];
  const revision = info.revision ? info.revision.slice(0, 7) : "소스 정보 없음";
  return [channel, info.buildNumber ? `#${info.buildNumber}` : "", revision + (info.dirty ? " · 수정됨" : "")].filter(Boolean).join(" · ");
}

export async function showBuildInfo(): Promise<void> {
  const version = document.getElementById("app-version");
  const details = document.getElementById("app-build");
  if (!version || !details) return;
  try {
    const info = await window.__TAURI__.core.invoke<BuildInfo>("get_build_info");
    version.textContent = `v${info.version}`;
    const builtAt = new Date(info.builtAtUnixSeconds * 1000).toLocaleString();
    details.textContent = `${formatBuildIdentity(info)}\n빌드 시각: ${builtAt}`;
  } catch (error) {
    version.textContent = "버전 정보를 가져오지 못했습니다";
    details.textContent = "";
    console.warn("Could not read app build information:", error);
  }
}
