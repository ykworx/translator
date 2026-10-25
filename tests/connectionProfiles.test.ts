import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readActiveConnection, createBackendForConnection, runtimeConnectionsEqual, getCredentialStatus, type RuntimeSnapshot } from "../src/connectionProfiles";
import { getProvider, listProviders } from "../src/providerRegistry";
import { registerInvokeCommand, resetInvokeCommands, resetTauriStore, setTauriStoreValue, setNativeCredential } from "./helpers/tauriMock";

beforeEach(() => { resetTauriStore(); resetInvokeCommands(); setNativeCredential("gemini-native", "fake-default-key"); });
afterEach(() => { resetInvokeCommands(); vi.unstubAllGlobals(); });

describe("provider registry and public connection profiles", () => {
  it("registers existing providers with their actual protocol and authentication", () => {
    expect(listProviders().map(provider => provider.id)).toEqual(["gemini-native", "openai", "ollama"]);
    expect(getProvider("ollama")).toMatchObject({ authKind: "none", baseUrl: "http://localhost:11434" });
    expect(getProvider("openai")).toMatchObject({ authKind: "api-key", protocol: "openai-compatible" });
    expect(Object.isFrozen(listProviders())).toBe(true);
    expect(Object.isFrozen(getProvider("ollama"))).toBe(true);
  });

  it.each(["constructor", "__proto__", "toString", "unknown"])("rejects an unregistered provider %s", id => {
    expect(() => getProvider(id)).toThrow("공급자");
  });

  it("projects the saved connection without serializing any API key", async () => {
    setTauriStoreValue("llmBackendId", "openai");
    setTauriStoreValue("openaiApiKey", "fake-active-private-key");
    setTauriStoreValue("apiKey", "fake-inactive-private-key");
    setTauriStoreValue("openaiModel", "gpt-4o-mini");
    const snapshot = await readActiveConnection();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("fake-active-private-key");
    expect(serialized).not.toContain("fake-inactive-private-key");
    expect(snapshot.profile).toMatchObject({ providerId: "openai", model: "gpt-4o-mini", auth: { kind: "api-key" } });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.profile)).toBe(true);
    expect(Object.isFrozen(snapshot.profile.auth)).toBe(true);
  });

  it("keeps credential rotation private but distinguishes runtime snapshots", async () => {
    setTauriStoreValue("llmBackendId", "openai");
    setTauriStoreValue("openaiApiKey", "fake-key-a");
    const first = await readActiveConnection();
    const same = await readActiveConnection();
    setTauriStoreValue("openaiApiKey", "fake-key-b");
    const rotated = await readActiveConnection();
    expect(runtimeConnectionsEqual(first, same)).toBe(true);
    expect(runtimeConnectionsEqual(first, rotated)).toBe(false);
    expect(JSON.stringify(first)).toBe(JSON.stringify(rotated));
  });

  it("uses one native capture without accessing or enumerating the settings store", async () => {
    const native = { profile: { id: "native:ollama", providerId: "ollama", protocol: "openai-compatible", baseUrl: "http://localhost:11434", model: "local-model", auth: { kind: "none" }, credentialRef: null }, runtimeId: "native-runtime" };
    const capture = vi.fn(() => native);
    registerInvokeCommand("capture_connection", capture);
    registerInvokeCommand("settings_entries", () => { throw new Error("must not enumerate settings"); });
    const snapshot = await readActiveConnection();
    expect(capture).toHaveBeenCalledOnce();
    expect(snapshot.profile.model).toBe("local-model");
  });

  it("cannot construct an authenticated backend from a serialized or forged profile", async () => {
    const snapshot = await readActiveConnection();
    const copy = JSON.parse(JSON.stringify(snapshot)) as RuntimeSnapshot;
    expect(() => createBackendForConnection(copy)).toThrow("유효하지 않은");
  });

  it.each([42, null, [], { model: "wrong" }])("rejects malformed active model values without choosing another provider: %j", async value => {
    setTauriStoreValue("llmBackendId", "ollama");
    setTauriStoreValue("ollamaModel", value);
    await expect(readActiveConnection()).rejects.toThrow("설정");
  });

  it("ignores unrelated malformed inactive provider fields", async () => {
    setTauriStoreValue("llmBackendId", "ollama");
    setTauriStoreValue("apiKey", { unused: true });
    setTauriStoreValue("openaiModel", null);
    const snapshot = await readActiveConnection();
    expect(snapshot.profile.providerId).toBe("ollama");
    expect(snapshot.profile.auth.kind).toBe("none");
    expect(snapshot.profile.credentialRef).toBeNull();
  });

  it("keeps missing-item repair metadata without treating it as an absent credential", async () => {
    registerInvokeCommand("get_credential_status", () => ({ configured: true, revision: "existing-reference", error: "Keychain 항목을 찾을 수 없습니다." }));
    expect(await getCredentialStatus("openai")).toEqual({ configured: true, revision: "existing-reference", error: "Keychain 항목을 찾을 수 없습니다." });
  });

  it("rejects malformed credential status data without returning unvalidated fields", async () => {
    registerInvokeCommand("get_credential_status", () => ({ configured: true, revision: "reference", error: { private: "not-a-message" } }));
    await expect(getCredentialStatus("openai")).rejects.toThrow("설정");
  });

  it("does not expose legacy secrets through the frontend settings bridge", async () => {
    setTauriStoreValue("apiKey", "fake-protected-key");
    for (const command of ["settings_get", "settings_set", "settings_delete"]) {
      await expect(window.__TAURI__.core.invoke(command, { rid: 1, key: "apiKey", value: "replacement" })).rejects.toThrow("보안 인증");
    }
  });
});
