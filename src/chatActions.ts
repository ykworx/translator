import { suggestReplies, summarize } from "./api";
import { chat, chatHistory, getChatRevision, type ChatEntry } from "./ui";
import { getErrorMessage } from "./utils";
import { writeTextToClipboard, writeWithTextFallback } from "./clipboard";
import { copyWithFeedback } from "./copyFeedback";

type Kind = "reply" | "summary";
interface Context { entry: ChatEntry; revision: number; original: string; translated: string }
interface Action {
  kind: Kind; button: HTMLButtonElement; label: string; status: HTMLDivElement;
  pending?: symbol; context?: Context; error?: string;
  renderedStatus?: string;
}

export function initChatActions(): () => void {
  const status = document.getElementById("chat-action-status")!;
  const hint = document.createElement("div");
  status.appendChild(hint);
  let disposed = false;
  const actions: Action[] = ([
    ["reply", "btn-suggest", "💬 답장"], ["summary", "btn-summarize", "📋 요약"],
  ] as const).map(([kind, id, label]) => {
    const row = document.createElement("div");
    row.className = "chat-action-message";
    status.appendChild(row);
    return { kind, label, button: document.getElementById(id) as HTMLButtonElement, status: row };
  });

  const loading = () => !!chat.querySelector("#streaming-entry, #loading-entry");
  function latest(): ChatEntry | undefined {
    const entry = chatHistory[chatHistory.length - 1];
    return entry?.translated.trim() && !entry.translated.startsWith("[오류]") ? entry : undefined;
  }
  function current(context: Context): boolean {
    return !disposed && !loading() && context.revision === getChatRevision() && latest() === context.entry
      && context.entry.original === context.original && context.entry.translated === context.translated;
  }

  function sync(): void {
    const reason = loading() ? "번역이 끝나면 답장과 요약을 사용할 수 있습니다."
      : latest() ? "" : chatHistory.length ? "마지막 번역을 다시 시도한 뒤 답장과 요약을 사용해주세요."
      : "번역 결과가 생기면 답장과 요약을 사용할 수 있습니다.";
    if (hint.textContent !== reason) hint.textContent = reason;
    for (const action of actions) {
      if (action.context && !current(action.context)) {
        action.pending = undefined;
        action.context = undefined;
        action.error = undefined;
      }
      const name = action.kind === "reply" ? "답장" : "요약";
      action.button.disabled = !!reason || !!action.pending;
      action.button.textContent = action.pending ? "생성 중…" : action.label;
      action.button.title = action.pending ? `${name}을 생성하고 있습니다.` : reason || `${name} 생성`;
      action.button.setAttribute("aria-busy", String(!!action.pending));
      const statusKey = action.pending ? `pending:${action.context?.revision}`
        : action.error ? `error:${action.context?.revision}:${action.error}` : "";
      if (action.renderedStatus === statusKey) continue;
      action.renderedStatus = statusKey;
      action.status.replaceChildren();
      if (action.pending) action.status.textContent = `${name} 생성 중…`;
      else if (action.error && action.context) {
        action.status.classList.add("error");
        action.status.appendChild(document.createTextNode(`${name} 생성 실패: ${action.error} `));
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "error-action-btn";
        retry.textContent = "다시 시도";
        const context = action.context;
        retry.addEventListener("click", () => { if (current(context)) void run(action, context); });
        action.status.appendChild(retry);
      }
      action.status.classList.toggle("error", !!action.error);
    }
  }

  async function run(action: Action, retryContext?: Context): Promise<void> {
    const entry = latest();
    if (!entry || loading() || action.pending || disposed) return;
    const context = retryContext ?? { entry, revision: getChatRevision(), original: entry.original, translated: entry.translated };
    if (!current(context)) return;
    const token = Symbol();
    action.context = context;
    action.pending = token;
    action.error = undefined;
    sync();
    const valid = () => action.pending === token && current(context);
    try {
      const section = document.createElement("div");
      section.className = "suggest-section";
      const label = document.createElement("div");
      label.className = "suggest-label";
      label.textContent = action.kind === "reply" ? "빠른 답장" : "내용 요약";
      section.appendChild(label);
      if (action.kind === "reply") {
        const suggestions = await suggestReplies(context.original, context.translated);
        if (!valid()) return;
        if (!suggestions.length) throw new Error("답장이 비어 있습니다. 다시 시도해주세요.");
        for (const suggestion of suggestions) {
          for (const [language, text] of [["KR", suggestion.kr], ["JP", suggestion.jp]] as const) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "suggest-btn";
            button.textContent = `${language}: ${text}`;
            button.addEventListener("click", () => void copyWithFeedback(
              () => writeWithTextFallback(() => writeTextToClipboard(text), text), button, `✓ ${language}: ${text}`));
            section.appendChild(button);
          }
        }
      } else {
        const result = await summarize(context.original, context.translated);
        if (!valid()) return;
        if (!result.trim()) throw new Error("요약이 비어 있습니다. 다시 시도해주세요.");
        const content = document.createElement("div");
        content.className = "summary-content";
        content.textContent = result;
        section.appendChild(content);
      }
      chat.appendChild(section);
      chat.scrollTop = chat.scrollHeight;
    } catch (error) {
      if (valid()) action.error = getErrorMessage(error);
    } finally {
      if (action.pending === token) {
        action.pending = undefined;
        sync();
      }
    }
  }

  const handlers = actions.map(action => {
    const handler = () => void run(action);
    action.button.addEventListener("click", handler);
    return handler;
  });
  document.addEventListener("chat-changed", sync);
  sync();
  return () => {
    disposed = true;
    document.removeEventListener("chat-changed", sync);
    actions.forEach((action, index) => { action.pending = undefined; action.button.removeEventListener("click", handlers[index]); });
  };
}
