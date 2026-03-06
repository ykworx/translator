#!/usr/bin/env python3
"""macOS 팝업 번역기 — Claude CLI / Gemini API (PyObjC 네이티브 UI)"""

import html as html_mod
import os
import signal
import threading
import time
from pathlib import Path

# .env 파일 로드
_env_path = Path(__file__).parent / ".env"
if _env_path.exists():
    for line in _env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

import AppKit
import objc
from Foundation import NSObject, NSTimer
from AppKit import (
    NSApplication, NSTextField, NSButton, NSScrollView, NSTextView,
    NSPanel, NSColor, NSFont, NSScreen, NSBackingStoreBuffered,
    NSWindowStyleMaskTitled, NSWindowStyleMaskClosable, NSWindowStyleMaskResizable,
    NSWindowStyleMaskFullSizeContentView,
    NSFloatingWindowLevel,
    NSTextAlignmentLeft,
    NSViewWidthSizable, NSViewHeightSizable, NSViewMinXMargin, NSViewMinYMargin, NSViewMaxYMargin,
    NSBezelStyleRounded,
)
from pynput.keyboard import Key, Controller as KBController

TARGET_LANG = "한국어"
LANGUAGES = ["한국어", "日本語", "English", "中文(简体)", "中文(繁體)", "Español", "Français", "Deutsch"]

# ─── Keychain Helpers ────────────────────────────────────────
_KEYCHAIN_SERVICE = "com.transrator.api-key"
_KEYCHAIN_ACCOUNT = "gemini"

def _keychain_save(api_key):
    """API 키를 macOS Keychain에 저장 (기존 값이 있으면 업데이트)"""
    import subprocess
    # 기존 키 삭제 (없어도 무시)
    subprocess.run(
        ["security", "delete-generic-password",
         "-s", _KEYCHAIN_SERVICE, "-a", _KEYCHAIN_ACCOUNT],
        capture_output=True
    )
    result = subprocess.run(
        ["security", "add-generic-password",
         "-s", _KEYCHAIN_SERVICE, "-a", _KEYCHAIN_ACCOUNT,
         "-w", api_key],
        capture_output=True, text=True
    )
    return result.returncode == 0

def _keychain_load():
    """Keychain에서 API 키 읽기. 없으면 None 반환"""
    import subprocess
    result = subprocess.run(
        ["security", "find-generic-password",
         "-s", _KEYCHAIN_SERVICE, "-a", _KEYCHAIN_ACCOUNT, "-w"],
        capture_output=True, text=True
    )
    if result.returncode == 0:
        return result.stdout.strip()
    return None

def _keychain_delete():
    """Keychain에서 API 키 삭제"""
    import subprocess
    subprocess.run(
        ["security", "delete-generic-password",
         "-s", _KEYCHAIN_SERVICE, "-a", _KEYCHAIN_ACCOUNT],
        capture_output=True
    )

# ─── Gemini Model Selection ──────────────────────────────────
GEMINI_MODELS = [
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
]
_defaults = AppKit.NSUserDefaults.standardUserDefaults()
_selected_gemini_model = str(_defaults.stringForKey_("geminiModel") or GEMINI_MODELS[0])
if _selected_gemini_model not in GEMINI_MODELS:
    _selected_gemini_model = GEMINI_MODELS[0]

# ─── Gemini client (lazy init) ───────────────────────────────
_gemini_model = None
def _get_api_key():
    """API 키 조회: Keychain → 환경변수 순"""
    key = _keychain_load()
    if key:
        return key
    return os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY", "")

def _reset_gemini():
    """Gemini 클라이언트 초기화 (키 변경 시 호출)"""
    global _gemini_model
    _gemini_model = None

def _get_gemini():
    global _gemini_model
    if _gemini_model is None:
        import google.generativeai as genai
        api_key = _get_api_key()
        if not api_key:
            raise RuntimeError("API 키가 설정되지 않았습니다. 메뉴바 → 설정에서 입력하세요.")
        genai.configure(api_key=api_key)
        _gemini_model = genai.GenerativeModel(_selected_gemini_model)
    return _gemini_model

# ─── Logging ─────────────────────────────────────────────────
def log(msg):
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)

# ─── Clipboard ────────────────────────────────────────────────
def get_clipboard():
    """클립보드에서 텍스트를 가져온다. HTML 테이블이면 (text, html) 튜플, 이미지면 ("__IMAGE__", png_data) 반환."""
    pb = AppKit.NSPasteboard.generalPasteboard()
    html = pb.stringForType_("public.html")
    text = pb.stringForType_(AppKit.NSPasteboardTypeString)
    text = text.strip() if text else ""
    # HTML에 <table>이 있으면 테이블 데이터
    if html and "<table" in html.lower():
        return (text, html.strip())
    # 이미지 확인 (텍스트가 없을 때만 — 스크린샷, 이미지 복사 등)
    if not text:
        img_data = pb.dataForType_(AppKit.NSPasteboardTypePNG)
        if not img_data:
            img_data = pb.dataForType_(AppKit.NSPasteboardTypeTIFF)
        if img_data:
            return ("__IMAGE__", bytes(img_data))
    return text

def set_clipboard(text):
    pb = AppKit.NSPasteboard.generalPasteboard()
    pb.clearContents()
    pb.setString_forType_(text, AppKit.NSPasteboardTypeString)

def set_clipboard_with_html(plain_text, html_text):
    """HTML과 플레인 텍스트를 모두 클립보드에 설정 (스프레드시트 붙여넣기용)"""
    pb = AppKit.NSPasteboard.generalPasteboard()
    pb.clearContents()
    pb.setString_forType_(plain_text, AppKit.NSPasteboardTypeString)
    pb.setString_forType_(html_text, "public.html")

# ─── Table Utilities ─────────────────────────────────────────
def _clean_table_html(raw_html):
    """구글 시트 등에서 복사한 HTML에서 <table>...</table> 부분만 추출하고 정리"""
    import re
    # <table> 태그 추출
    m = re.search(r'<table[^>]*>.*?</table>', raw_html, re.DOTALL | re.IGNORECASE)
    if not m:
        return raw_html
    table_html = m.group(0)
    # 인라인 스타일 제거 (번역 시 토큰 낭비 방지)
    table_html = re.sub(r'\s+style="[^"]*"', '', table_html)
    # data-* 속성 제거
    table_html = re.sub(r'\s+data-[a-z-]+="[^"]*"', '', table_html)
    # class 속성 제거
    table_html = re.sub(r'\s+class="[^"]*"', '', table_html)
    return table_html

def _tsv_to_html_table(tsv_text):
    """TSV 텍스트를 HTML 테이블로 변환 (HTML이 없을 때 폴백용)"""
    rows = tsv_text.strip().split("\n")
    parts = ["<table>"]
    for row in rows:
        parts.append("<tr>")
        for cell in row.split("\t"):
            parts.append(f"<td>{html_mod.escape(cell)}</td>")
        parts.append("</tr>")
    parts.append("</table>")
    return "".join(parts)

def copy_selection():
    """현재 선택된 텍스트를 클립보드에 복사 (⌘+C 전송)"""
    kb = KBController()
    kb.press(Key.cmd)
    kb.press('c')
    kb.release('c')
    kb.release(Key.cmd)

# ─── Model API Call ──────────────────────────────────────────
def _call_model(prompt):
    """Gemini API로 프롬프트를 전송하고 응답 텍스트를 반환"""
    resp = _get_gemini().generate_content(prompt)
    return resp.text.strip()

# ─── Translation ──────────────────────────────────────────────
def translate(text, table_html=None, target_lang=None):
    """텍스트 번역. table_html이 있으면 HTML 구조를 보존하며 번역."""
    lang = target_lang or TARGET_LANG
    if table_html:
        prompt = (
            f"Translate ALL Japanese text in the following HTML table to {lang}.\n"
            "IMPORTANT RULES:\n"
            f"- Translate ALL Japanese text to {lang}, including technical terms\n"
            "- Keep ALL HTML tags and attributes (rowspan, colspan, etc.) EXACTLY as-is\n"
            "- Do NOT translate: product IDs (e.g. AF-01), version numbers, URLs, English words\n"
            "- Do NOT add, remove, or modify any HTML tags\n"
            "- Output ONLY the translated HTML table, nothing else\n\n"
            f"{table_html}"
        )
    else:
        prompt = (
            f"Translate the following text to {lang}. "
            "Output ONLY the translated text, nothing else.\n\n"
            f"{text}"
        )
    try:
        mode = "HTML 테이블" if table_html else "텍스트"
        log(f"[gemini] 번역 중… ({mode}, 길이: {len(table_html or text)}자)")
        result = _call_model(prompt)
        # AI가 마크다운 코드 블록으로 감싸는 경우 제거
        if result.startswith("```"):
            lines = result.split("\n")
            # 첫 줄(```html 등)과 마지막 줄(```) 제거
            if lines[-1].strip() == "```":
                lines = lines[1:-1]
            else:
                lines = lines[1:]
            result = "\n".join(lines).strip()
        log("번역 완료")
        return result
    except Exception as e:
        log(f"번역 오류: {e}")
        return f"[오류] {e}"

def translate_image(image_data, target_lang=None):
    """이미지 속 일본어 텍스트를 추출하고 번역 (Gemini Vision)"""
    lang = target_lang or TARGET_LANG
    try:
        log(f"[gemini] 이미지 번역 중… ({len(image_data)} bytes)")
        gemini = _get_gemini()
        image_part = {"mime_type": "image/png", "data": image_data}
        prompt = (
            f"This image contains Japanese text. Do the following:\n"
            f"1. Extract ALL text from the image\n"
            f"2. Translate ALL Japanese text to {lang}\n\n"
            f"Format your response EXACTLY like this:\n"
            f"[원문]\n(extracted Japanese text)\n\n"
            f"[번역]\n(Korean translation)"
        )
        resp = gemini.generate_content([prompt, image_part])
        result = resp.text.strip()
        log("이미지 번역 완료")
        return result
    except Exception as e:
        log(f"이미지 번역 오류: {e}")
        return f"[오류] {e}"

def suggest_replies(original, translated):
    """번역된 메시지에 대한 빠른 답장 생성 (한국어 + 일본어)"""
    prompt = (
        "You are a helpful assistant for a Korean professional working in a Japanese company that uses Slack.\n"
        "Based on the following message, suggest 3 short reply options.\n"
        "For each reply, provide both Korean and Japanese versions.\n"
        "Format: KR: 한국어답장 | JP: 日本語返信\n\n"
        "Japanese reply style guide:\n"
        "- Use polite business Japanese (です/ます体), not overly formal (e.g. 承知しました, not 承知いたしました)\n"
        "- Keep it concise: 1-2 sentences, no email-style greetings (skip お疲れ様です)\n"
        "- Common patterns: 承知しました / 確認します / ありがとうございます / お願いします\n"
        "- Slack-appropriate: brief and direct, not stiff\n"
        "- Warm and friendly tone: use expressions like 助かります, ありがとうございます, よろしくお願いします\n\n"
        "Output ONLY the 3 replies, numbered 1. 2. 3.\n"
        "Keep each version under 80 characters.\n\n"
        f"Original message: {original}\n"
        f"Korean translation: {translated}"
    )
    try:
        log("[gemini] 빠른 답장 생성 중…")
        raw = _call_model(prompt)
        suggestions = []
        for line in raw.split("\n"):
            line = line.strip()
            if not line:
                continue
            if line[0].isdigit():
                line = line.split(".", 1)[-1].strip()
            if "KR:" in line and "JP:" in line:
                parts = line.split("|")
                kr = parts[0].replace("KR:", "").strip()
                jp = parts[1].replace("JP:", "").strip() if len(parts) > 1 else ""
                suggestions.append({"kr": kr, "jp": jp})
        log(f"빠른 답장 {len(suggestions)}개 생성")
        return suggestions[:3]
    except Exception as e:
        log(f"빠른 답장 오류: {e}")
        return []

def korean_pronunciation(text):
    """원문의 한국어 발음을 생성"""
    prompt = (
        "다음 텍스트의 한국어 발음(읽는 법)을 적어주세요.\n"
        "규칙:\n"
        "- 일본어는 한국어 음독/훈독으로 표기 (예: ありがとう → 아리가토우)\n"
        "- 영어는 한국어 발음으로 표기 (예: hello → 헬로)\n"
        "- 한자는 일본어 읽는 법의 한국어 표기 (예: 確認 → 카쿠닌)\n"
        "- 발음만 출력하세요. 설명이나 부가 텍스트 없이 발음만.\n\n"
        f"텍스트: {text}"
    )
    return _call_model(prompt)

# ─── Screen (마우스 커서가 있는 화면) ────────────────────────────
def active_screen():
    mouse_loc = AppKit.NSEvent.mouseLocation()
    for screen in NSScreen.screens():
        if AppKit.NSPointInRect(mouse_loc, screen.frame()):
            return screen
    return NSScreen.mainScreen()

# ─── Colors (시스템 테마 — 다크/라이트 자동 대응) ────────────
BG = NSColor.windowBackgroundColor()
FG = NSColor.labelColor()
FG_DIM = NSColor.secondaryLabelColor()
SURFACE = NSColor.controlBackgroundColor()

# ─── Translation Input Window (Spotlight 스타일) ─────────────
class KeyablePanel(NSPanel):
    """Borderless NSPanel이 키 입력을 받을 수 있도록 오버라이드"""
    def canBecomeKeyWindow(self):
        return True
    def canBecomeMainWindow(self):
        return True

class WebMessageHandler(NSObject):
    """WKWebView JS → Native 메시지 핸들러"""
    def initWithCoordinator_(self, coordinator):
        self = objc.super(WebMessageHandler, self).init()
        if self:
            self._coordinator = coordinator
        return self

    def userContentController_didReceiveScriptMessage_(self, controller, message):
        try:
            body = str(message.body())
            log(f"[WebMessage] pron 요청: {body[:40]}")
            self._coordinator.onPronunciationFromJS_(body)
        except Exception as e:
            log(f"[WebMessage] 오류: {e}")


class MultilineInputView(AppKit.NSTextView):
    """멀티라인 입력: Enter→전송, Shift+Enter→줄바꿈"""
    def initWithFrame_(self, frame):
        self = objc.super(MultilineInputView, self).initWithFrame_(frame)
        if self:
            self._on_submit = None
            self._placeholder = "번역할 텍스트 입력… (Enter)"
        return self

    def keyDown_(self, event):
        if event.keyCode() == 36:  # Enter
            flags = event.modifierFlags()
            if flags & AppKit.NSEventModifierFlagShift:
                # Shift+Enter → 줄바꿈
                self.insertNewlineIgnoringFieldEditor_(self)
            else:
                # Enter → 전송
                text = str(self.string()).strip()
                if text and self._on_submit:
                    self._on_submit(text)
            return
        objc.super(MultilineInputView, self).keyDown_(event)

    def becomeFirstResponder(self):
        result = objc.super(MultilineInputView, self).becomeFirstResponder()
        self.setNeedsDisplay_(True)
        return result

    def drawRect_(self, rect):
        objc.super(MultilineInputView, self).drawRect_(rect)
        if not self.string() and self != self.window().firstResponder():
            return
        if not self.string():
            attrs = {
                AppKit.NSFontAttributeName: self.font(),
                AppKit.NSForegroundColorAttributeName: AppKit.NSColor.placeholderTextColor(),
            }
            placeholder = AppKit.NSAttributedString.alloc().initWithString_attributes_(
                self._placeholder, attrs
            )
            placeholder.drawAtPoint_((self.textContainerInset().width + 4, self.textContainerInset().height))

    def setStringValue_(self, val):
        """NSTextField 호환 인터페이스"""
        self.setString_(val)


class InputFieldDelegate(NSObject):
    """NSTextField delegate: Enter로 번역, Esc로 닫기"""
    def init(self):
        self = objc.super(InputFieldDelegate, self).init()
        if self is None:
            return None
        self._on_submit = None
        self._on_cancel = None
        return self

    def control_textView_doCommandBySelector_(self, control, tv, selector):
        sel_name = str(selector)
        if sel_name == "insertNewline:":
            if self._on_submit:
                self._on_submit(str(control.stringValue()))
            return True
        if sel_name == "cancelOperation:":
            if self._on_cancel:
                self._on_cancel()
            return True
        return False


class TranslatorInputWindow:
    """Spotlight 스타일 번역 입력창"""
    def __init__(self):
        self.panel = None
        self._delegate = None
        self._lang_popup = None

    def toggle(self, coordinator):
        if self.panel and self.panel.isVisible():
            self._close()
            return
        self._show(coordinator)

    def selected_language(self):
        """현재 선택된 언어 반환"""
        if self._lang_popup:
            return str(self._lang_popup.titleOfSelectedItem())
        return TARGET_LANG

    def _show(self, coordinator):
        self._close()
        screen = active_screen().visibleFrame()
        lang_w = 100
        w, h = 500 + lang_w + 8, 48
        x = screen.origin.x + (screen.size.width - w) / 2
        y = screen.origin.y + screen.size.height - h - 200  # 화면 상단 근처

        self.panel = KeyablePanel.alloc().initWithContentRect_styleMask_backing_defer_(
            ((x, y), (w, h)),
            AppKit.NSWindowStyleMaskBorderless,
            NSBackingStoreBuffered, False
        )
        self.panel.setLevel_(NSFloatingWindowLevel + 1)
        self.panel.setHidesOnDeactivate_(True)
        self.panel.setBecomesKeyOnlyIfNeeded_(False)
        self.panel.setMovableByWindowBackground_(True)
        self.panel.setBackgroundColor_(NSColor.clearColor())
        self.panel.setOpaque_(False)

        # 둥근 모서리 배경
        content = self.panel.contentView()
        content.setWantsLayer_(True)
        content.layer().setCornerRadius_(12)
        content.layer().setMasksToBounds_(True)
        content.setBackgroundColor_(BG)

        # 언어 선택 팝업
        lang_popup = AppKit.NSPopUpButton.alloc().initWithFrame_pullsDown_(
            ((12, 8), (lang_w, 32)), False
        )
        lang_popup.addItemsWithTitles_(LANGUAGES)
        # 이전 선택 복원
        last_lang = _defaults.stringForKey_("target_language") or TARGET_LANG
        idx = LANGUAGES.index(last_lang) if last_lang in LANGUAGES else 0
        lang_popup.selectItemAtIndex_(idx)
        lang_popup.setFont_(NSFont.systemFontOfSize_(13))
        lang_popup.setBordered_(False)
        lang_popup.setFocusRingType_(1)
        content.addSubview_(lang_popup)
        self._lang_popup = lang_popup

        # 입력 필드
        field_x = 12 + lang_w + 8
        field_w = w - field_x - 12
        field = NSTextField.alloc().initWithFrame_(((field_x, 8), (field_w, 32)))
        field.setPlaceholderString_("번역할 내용을 입력하거나 붙여넣으세요.")
        field.setFont_(NSFont.systemFontOfSize_(16))
        field.setBordered_(False)
        field.setFocusRingType_(1)  # NSFocusRingTypeNone
        field.setBackgroundColor_(NSColor.clearColor())
        field.setTextColor_(FG)

        self._delegate = InputFieldDelegate.alloc().init()
        self._delegate._on_submit = lambda text: coordinator.onInputSubmit_(text)
        self._delegate._on_cancel = lambda: self._close()
        field.setDelegate_(self._delegate)

        content.addSubview_(field)
        self._field = field

        self.panel.makeKeyAndOrderFront_(None)
        self.panel.makeFirstResponder_(field)
        NSApplication.sharedApplication().activateIgnoringOtherApps_(True)

    def _close(self):
        if self.panel:
            self.panel.orderOut_(None)
            self.panel = None
            self._delegate = None
            self._lang_popup = None

    def clear_and_close(self):
        self._close()


# ─── Menu Bar Status Item ─────────────────────────────────────
class StatusBarItem(NSObject):
    """macOS 메뉴바 상태 아이콘"""
    def init(self):
        self = objc.super(StatusBarItem, self).init()
        if self is None:
            return None
        self._status_item = None
        self._coordinator = None

        self._anim_timer = None
        self._anim_frame = 0
        self._anim_images = []
        self._static_image = None
        return self

    def _load_icon(self, filename):
        path = os.path.join(os.path.dirname(__file__), filename)
        img = AppKit.NSImage.alloc().initWithContentsOfFile_(path)
        if img:
            img.setSize_((18, 18))
            img.setTemplate_(True)
        return img

    def setupWithMessage_coordinator_(self, message, coordinator=None):
        if coordinator:
            self._coordinator = coordinator
        if self._status_item:
            return

        # 애니메이션 프레임 로드
        self._static_image = self._load_icon("menubar_icon.png")
        for i in range(4):
            frame = self._load_icon(f"menubar_icon_{i}.png")
            if frame:
                self._anim_images.append(frame)

        sb = AppKit.NSStatusBar.systemStatusBar()
        self._status_item = sb.statusItemWithLength_(AppKit.NSVariableStatusItemLength)

        if self._static_image:
            self._status_item.button().setImage_(self._static_image)
        else:
            self._status_item.button().setTitle_("🌐")
        self._status_item.button().setToolTip_(message)

        # 좌클릭: 번역 실행 / 우클릭: 메뉴 표시
        btn = self._status_item.button()
        btn.setTarget_(self)
        btn.setAction_(objc.selector(self.onStatusBarClick_, signature=b"v@:@"))
        # sendActionOn: 좌클릭(1) + 우클릭(2)
        btn.sendActionOn_(AppKit.NSEventMaskLeftMouseUp | AppKit.NSEventMaskRightMouseUp)

        self._menu = self._build_menu()

    def onStatusBarClick_(self, sender):
        event = AppKit.NSApp.currentEvent()
        if event and event.type() == AppKit.NSEventTypeRightMouseUp:
            self._status_item.popUpStatusItemMenu_(self._menu)
        else:
            # 좌클릭 → 결과창 토글
            if self._coordinator:
                self._coordinator.toggleResultWindow_(None)

    def _build_menu(self):
        menu = AppKit.NSMenu.alloc().init()

        # 상태 표시 (비활성)
        status_item = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
            "⌘+Ctrl+T: 팝업번역기", None, "")
        status_item.setEnabled_(False)
        menu.addItem_(status_item)

        menu.addItem_(AppKit.NSMenuItem.separatorItem())

        # 설정
        settings_item = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
            "설정…", objc.selector(self._coordinator.onSettings_, signature=b"v@:@"), "")
        settings_item.setTarget_(self._coordinator)
        menu.addItem_(settings_item)

        # About
        about_item = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
            "About…", objc.selector(self._coordinator.onAbout_, signature=b"v@:@"), "")
        about_item.setTarget_(self._coordinator)
        menu.addItem_(about_item)

        # 종료
        quit_item = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
            "종료", objc.selector(self._coordinator.onQuit_, signature=b"v@:@"), "")
        quit_item.setTarget_(self._coordinator)
        menu.addItem_(quit_item)

        return menu

    def animateFrame_(self, timer):
        """NSTimer 콜백: 다음 프레임으로 전환"""
        if not self._anim_images or not self._status_item:
            return
        self._anim_frame = (self._anim_frame + 1) % len(self._anim_images)
        self._status_item.button().setImage_(self._anim_images[self._anim_frame])

    def set_status(self, message):
        """번역 중 애니메이션 시작"""
        if not self._status_item:
            return
        if self._anim_images and not self._anim_timer:
            self._anim_frame = 0
            self._anim_timer = NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
                0.3, self, "animateFrame:", None, True
            )

    def reset_status(self):
        """애니메이션 중지, 기본 아이콘 복원"""
        if self._anim_timer:
            self._anim_timer.invalidate()
            self._anim_timer = None
        if self._status_item and self._static_image:
            self._status_item.button().setImage_(self._static_image)

# ─── Result Window ────────────────────────────────────────────
class TranslatorWindow:
    def __init__(self):
        self.panel = None
        self._result_input = None
        self._input_delegate = None
        self._webview = None
        self._lang_popup = None
        self._msg_handler = None
        self._chat_history = []  # [{original, translated}, ...]
        self._coordinator = None

    def _detect_theme(self):
        appearance = AppKit.NSApp.effectiveAppearance()
        return "Dark" in str(appearance.name())

    def show_result(self, original, translated, coordinator=None, is_table=False, original_html=None, is_image=False, image_data=None):
        self._is_table = is_table
        self._is_image = is_image
        self._original_html = original_html
        self._original = original
        self._translated = translated
        self._suggest_area_built = False
        self._coordinator = coordinator

        is_dark = self._detect_theme()

        # 채팅 엔트리 생성
        entry = {"original": original, "translated": translated}
        if is_image and image_data:
            import base64
            entry["image_b64"] = base64.b64encode(image_data).decode("ascii")
        if is_table:
            entry["is_table"] = True
            if original_html:
                entry["original_html"] = original_html

        # 기존 채팅 창이 있으면 추가
        if self.panel and self._webview:
            self.remove_loading()
            self._chat_history.append(entry)
            if len(self._chat_history) > 50:
                self._chat_history = self._chat_history[-50:]
            self._append_chat_entry(entry)
            if self._result_input:
                self._result_input.setStringValue_("")
            self.panel.orderFrontRegardless()
            NSApplication.sharedApplication().activateIgnoringOtherApps_(True)
            return

        self._close()

        panel_w, panel_h = 520, 480
        self._chat_history = [entry]

        self._create_panel(panel_w, panel_h)
        self.panel.setMinSize_((400, 360))

        content = self.panel.contentView()
        content.setAutoresizesSubviews_(True)
        w = panel_w - 40

        self._build_text_layout(content, self._chat_history, panel_h, w, coordinator, is_dark)

        self.panel.orderFrontRegardless()
        NSApplication.sharedApplication().activateIgnoringOtherApps_(True)

    def _theme_colors(self, is_dark):
        if is_dark:
            return {
                "bg": "transparent", "card_bg": "rgba(255,255,255,0.06)",
                "fg": "#e8e8e8", "fg_dim": "#999",
                "border": "rgba(255,255,255,0.1)", "divider": "rgba(255,255,255,0.06)",
            }
        return {
            "bg": "transparent", "card_bg": "rgba(0,0,0,0.04)",
            "fg": "#1a1a1a", "fg_dim": "#888",
            "border": "rgba(0,0,0,0.1)", "divider": "rgba(0,0,0,0.06)",
        }

    def _render_chat_entry(self, entry):
        escaped_orig = html_mod.escape(entry["original"].strip()).replace("\n", "<br>")
        escaped_trans = html_mod.escape(entry["translated"].strip()).replace("\n", "<br>")
        data_text = html_mod.escape(entry["translated"], quote=True)
        copy_js = "var t=this.parentElement.dataset.text;var a=document.createElement('textarea');a.value=t;document.body.appendChild(a);a.select();document.execCommand('copy');document.body.removeChild(a);this.innerText='\\u2713 복사됨';this.classList.add('copied');var b=this;setTimeout(function(){b.classList.remove('copied');setTimeout(function(){b.innerText='복사'},300)},1200)"

        # 이미지가 포함된 엔트리
        image_b64 = entry.get("image_b64")
        is_table = entry.get("is_table", False)

        if image_b64:
            orig_html = f'<img class="orig-img" src="data:image/png;base64,{image_b64}" />'
            if escaped_orig and escaped_orig != "(이미지에서 추출)":
                orig_html += f'<div class="orig-text">{escaped_orig}</div>'
            orig_label = "원본 이미지"
        elif is_table:
            # 테이블: 원본 HTML 그대로 렌더링
            orig_html_raw = entry.get("original_html", "")
            orig_html = f'<div class="table-wrap">{orig_html_raw}</div>' if orig_html_raw else escaped_orig
            orig_label = "원문"
        else:
            orig_html = escaped_orig
            orig_label = "원문"

        # 번역 결과: 테이블이면 HTML 그대로
        if is_table and "<table" in entry["translated"].lower():
            trans_html = f'<div class="table-wrap">{entry["translated"]}</div>'
        else:
            trans_html = escaped_trans

        orig_data = html_mod.escape(entry["original"], quote=True)
        pron_js = "getPron(this)"

        return f'''<div class="entry">
    <div class="section original">
        <div class="label">{orig_label}</div>
        <div class="card orig" data-orig="{orig_data}"><span class="pron-btn" onclick="{pron_js}">발음</span>{orig_html}</div>
    </div>
    <div class="section translated">
        <div class="label">번역 결과</div>
        <div class="card trans" data-text="{data_text}"><span class="copy-btn" onclick="{copy_js}">복사</span>{trans_html}</div>
    </div>
</div>'''

    def _chat_css(self, c):
        return f'''* {{ margin:0; padding:0; box-sizing:border-box; }}
::-webkit-scrollbar {{ width: 6px; }}
::-webkit-scrollbar-track {{ background: transparent; }}
::-webkit-scrollbar-thumb {{ background: rgba(128,128,128,0.3); border-radius: 3px; }}
::-webkit-scrollbar-thumb:hover {{ background: rgba(128,128,128,0.5); }}
body {{
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
    background: {c["bg"]}; color: {c["fg"]}; padding: 20px 24px 16px;
    -webkit-user-select: text; line-height: 1.65;
}}
.entry {{ padding-bottom: 16px; margin-bottom: 16px; border-bottom: 1px solid {c["divider"]}; }}
.entry:last-child {{ border-bottom: none; margin-bottom: 0; }}
.section {{ margin-bottom: 14px; }}
.section:last-child {{ margin-bottom: 0; }}
.label {{
    font-size: 11px; font-weight: 600; color: {c["fg_dim"]};
    text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;
}}
.card {{
    background: {c["card_bg"]}; border-radius: 14px;
    padding: 16px 18px; border: 1px solid {c["border"]};
}}
.card.orig {{ font-size: 13px; color: {c["fg_dim"]}; line-height: 1.6; position: relative; }}
.orig-img {{ max-width: 100%; border-radius: 8px; display: block; }}
.orig-text {{ margin-top: 10px; }}
.card.trans {{ font-size: 14.5px; color: {c["fg"]}; line-height: 1.7; position: relative; }}
.copy-btn {{
    position: absolute; top: 10px; right: 10px;
    background: {c["card_bg"]}; border: 1px solid {c["border"]};
    border-radius: 6px; padding: 3px 8px;
    font-size: 11px; color: {c["fg_dim"]}; cursor: pointer;
    opacity: 0; transition: opacity 0.2s;
}}
.card.trans:hover .copy-btn {{ opacity: 1; }}
.copy-btn.copied {{ opacity: 1 !important; }}
.copy-btn:hover {{ color: {c["fg"]}; background: rgba(128,128,128,0.15); }}
.pron-btn {{
    position: absolute; top: 10px; right: 10px;
    background: {c["card_bg"]}; border: 1px solid {c["border"]};
    border-radius: 6px; padding: 3px 8px;
    font-size: 11px; color: {c["fg_dim"]}; cursor: pointer;
    opacity: 0; transition: opacity 0.2s;
}}
.card.orig:hover .pron-btn {{ opacity: 1; }}
.pron-btn.loading {{ opacity: 1 !important; }}
.pron-area {{
    margin-top: 10px; padding-top: 8px;
    border-top: 1px solid rgba(128,128,128,0.2);
    font-size: 12px; color: {c["fg_dim"]};
}}
.table-wrap {{ overflow-x: auto; }}
.table-wrap table {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
.table-wrap th, .table-wrap td {{
    border: 1px solid {c["border"]}; padding: 8px 10px;
    text-align: left; vertical-align: top;
}}
.table-wrap th {{ background: rgba(128,128,128,0.1); font-weight: 600; }}
@keyframes blink {{ 0%,80%,100% {{ opacity:0 }} 40% {{ opacity:1 }} }}
.loading-dots span {{
    display: inline-block; width: 6px; height: 6px; margin: 0 2px;
    border-radius: 50%; background: {c["fg_dim"]};
    animation: blink 1.4s infinite both;
}}
.loading-dots span:nth-child(2) {{ animation-delay: 0.2s; }}
.loading-dots span:nth-child(3) {{ animation-delay: 0.4s; }}'''

    def _build_text_layout(self, content, chat_history, panel_h, w, coordinator, is_dark):
        """채팅 스타일 텍스트 결과 레이아웃"""
        import objc as _objc
        _wk = {}
        _objc.loadBundle('WebKit', _wk, bundle_path='/System/Library/Frameworks/WebKit.framework')
        WKWebView = _wk['WKWebView']
        WKWebViewConfiguration = _wk['WKWebViewConfiguration']

        c = self._theme_colors(is_dark)
        entries_html = "\n".join(self._render_chat_entry(e) for e in chat_history)

        pron_script = '''function getPron(btn){
if(btn.classList.contains('loading'))return;
var card=btn.closest('.card.orig');
if(!card||card.querySelector('.pron-area'))return;
btn.classList.add('loading');btn.innerText='생성 중…';
var text=card.dataset.orig;
window.webkit.messageHandlers.pron.postMessage(text);
}'''

        html_str = f'''<!DOCTYPE html><html><head><meta charset="utf-8">
<style>{self._chat_css(c)}</style>
</head><body>
<div id="chat">{entries_html}</div>
<script>
window.onload=function(){{window.scrollTo(0,document.body.scrollHeight);}};
{pron_script}
</script>
</body></html>'''

        config = WKWebViewConfiguration.alloc().init()
        # JS → Native 메시지 핸들러
        self._msg_handler = WebMessageHandler.alloc().initWithCoordinator_(coordinator)
        config.userContentController().addScriptMessageHandler_name_(self._msg_handler, "pron")
        top_margin = 38
        # 레이아웃: [빠른답장 28+6] [입력배경 60+8]
        btn_row_h = 30
        input_h = 60
        bottom_area = btn_row_h + input_h + 12  # 102

        wv = WKWebView.alloc().initWithFrame_configuration_(
            ((0, bottom_area), (w + 40, panel_h - top_margin - bottom_area)),
            config
        )
        wv.loadHTMLString_baseURL_(html_str, None)
        wv.setValue_forKey_(False, "drawsBackground")
        wv.setAutoresizingMask_(NSViewWidthSizable | NSViewHeightSizable)
        content.addSubview_(wv)
        self._webview = wv

        # 하단 입력 영역 블러 배경
        blur_bg = AppKit.NSVisualEffectView.alloc().initWithFrame_(((0, 0), (w + 40, bottom_area)))
        blur_bg.setBlendingMode_(1)  # NSVisualEffectBlendingModeWithinWindow
        blur_bg.setMaterial_(3)      # NSVisualEffectMaterialHUDWindow
        blur_bg.setState_(1)         # NSVisualEffectStateActive
        blur_bg.setAutoresizingMask_(NSViewWidthSizable | NSViewMaxYMargin)
        content.addSubview_(blur_bg)

        # 입력 필드 배경 (둥근 모서리)
        input_bg_y = btn_row_h + 4
        input_bg = AppKit.NSView.alloc().initWithFrame_(((12, input_bg_y), (w + 40 - 24, input_h)))
        input_bg.setWantsLayer_(True)
        input_bg.layer().setCornerRadius_(12)
        input_bg.layer().setBorderWidth_(1)
        if is_dark:
            input_bg.layer().setBorderColor_(AppKit.NSColor.colorWithWhite_alpha_(1.0, 0.1).CGColor())
            input_bg.layer().setBackgroundColor_(AppKit.NSColor.colorWithWhite_alpha_(1.0, 0.05).CGColor())
        else:
            input_bg.layer().setBorderColor_(AppKit.NSColor.colorWithWhite_alpha_(0.0, 0.1).CGColor())
            input_bg.layer().setBackgroundColor_(AppKit.NSColor.colorWithWhite_alpha_(0.0, 0.03).CGColor())
        input_bg.setAutoresizingMask_(NSViewWidthSizable | NSViewMaxYMargin)
        content.addSubview_(input_bg)

        # 언어 선택 팝업 (입력 배경 안 우측)
        lang_w = 100
        lang_h = 28
        lang_y = input_bg_y + (input_h - lang_h) / 2
        lang_x = w + 40 - 12 - lang_w
        lang_popup = AppKit.NSPopUpButton.alloc().initWithFrame_pullsDown_(
            ((lang_x, lang_y), (lang_w, lang_h)), False
        )
        lang_popup.addItemsWithTitles_(LANGUAGES)
        last_lang = _defaults.stringForKey_("target_language") or TARGET_LANG
        idx = LANGUAGES.index(last_lang) if last_lang in LANGUAGES else 0
        lang_popup.selectItemAtIndex_(idx)
        lang_popup.setFont_(NSFont.systemFontOfSize_(12))
        lang_popup.setBordered_(False)
        lang_popup.setFocusRingType_(1)
        lang_popup.setAutoresizingMask_(NSViewMinXMargin | NSViewMaxYMargin)
        content.addSubview_(lang_popup)
        self._lang_popup = lang_popup

        # 멀티라인 입력 필드 (언어 팝업 좌측)
        field_x = 18
        field_y = input_bg_y + 6
        field_w = lang_x - field_x - 4
        field_h = input_h - 12

        scroll = AppKit.NSScrollView.alloc().initWithFrame_(((field_x, field_y), (field_w, field_h)))
        scroll.setHasVerticalScroller_(True)
        scroll.setBorderType_(0)
        scroll.setBackgroundColor_(NSColor.clearColor())
        scroll.setDrawsBackground_(False)
        scroll.setAutoresizingMask_(NSViewWidthSizable | NSViewMaxYMargin)

        input_tv = MultilineInputView.alloc().initWithFrame_(((0, 0), (field_w, field_h)))
        input_tv.setFont_(NSFont.systemFontOfSize_(13))
        input_tv.setBackgroundColor_(NSColor.clearColor())
        input_tv.setTextColor_(FG)
        input_tv.setRichText_(False)
        input_tv.setAllowsUndo_(True)
        input_tv.setTextContainerInset_((4, 4))
        input_tv.textContainer().setLineFragmentPadding_(4)
        input_tv.setVerticallyResizable_(True)
        input_tv.setHorizontallyResizable_(False)
        input_tv.textContainer().setWidthTracksTextView_(True)
        input_tv._on_submit = lambda text: coordinator.onResultInputSubmit_(text)
        scroll.setDocumentView_(input_tv)
        content.addSubview_(scroll)
        self._result_input = input_tv

        # 빠른 답장 버튼 (입력창 하단 좌측)
        suggest_btn = NSButton.alloc().initWithFrame_(((16, 4), (110, 24)))
        suggest_btn.setTitle_("💬 빠른 답장")
        suggest_btn.setBezelStyle_(NSBezelStyleRounded)
        suggest_btn.setBordered_(False)
        suggest_btn.setFont_(NSFont.systemFontOfSize_(11))
        suggest_btn.setTarget_(coordinator)
        suggest_btn.setAction_(objc.selector(coordinator.onRequestSuggest_, signature=b"v@:@"))
        suggest_btn.setAutoresizingMask_(NSViewMaxYMargin)
        content.addSubview_(suggest_btn)
        self._suggest_btn = suggest_btn

        # 초기화 버튼 (우측 하단)
        clear_btn = NSButton.alloc().initWithFrame_(((w + 40 - 80 - 16, 4), (80, 24)))
        clear_btn.setTitle_("🗑 초기화")
        clear_btn.setBezelStyle_(NSBezelStyleRounded)
        clear_btn.setBordered_(False)
        clear_btn.setFont_(NSFont.systemFontOfSize_(11))
        clear_btn.setTarget_(coordinator)
        clear_btn.setAction_(objc.selector(coordinator.onClearChat_, signature=b"v@:@"))
        clear_btn.setAutoresizingMask_(NSViewMinXMargin | NSViewMaxYMargin)
        content.addSubview_(clear_btn)

    def show_loading(self, original):
        """번역 중 로딩 표시: 원문 + dots 애니메이션"""
        if not self._webview:
            return
        escaped_orig = html_mod.escape(original).replace("\n", "<br>")
        orig_data = html_mod.escape(original, quote=True)
        pron_js = "getPron(this)"
        loading_html = f'''<div class="entry" id="loading-entry">
    <div class="section original">
        <div class="label">원문</div>
        <div class="card orig" data-orig="{orig_data}"><span class="pron-btn" onclick="{pron_js}">발음</span>{escaped_orig}</div>
    </div>
    <div class="section translated">
        <div class="label">번역 결과</div>
        <div class="card trans"><div class="loading-dots"><span></span><span></span><span></span></div></div>
    </div>
</div>'''
        js_html = loading_html.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")
        js = (
            "var chat=document.getElementById('chat');"
            "var div=document.createElement('div');"
            f"div.innerHTML='{js_html}';"
            "while(div.firstChild)chat.appendChild(div.firstChild);"
            "window.scrollTo(0,document.body.scrollHeight);"
        )
        self._webview.evaluateJavaScript_completionHandler_(js, None)

    def remove_loading(self):
        """로딩 엔트리 제거"""
        if not self._webview:
            return
        js = "var el=document.getElementById('loading-entry');if(el)el.remove();"
        self._webview.evaluateJavaScript_completionHandler_(js, None)

    def _append_chat_entry(self, entry):
        """기존 WKWebView에 새 채팅 엔트리를 JS로 추가"""
        entry_html = self._render_chat_entry(entry)
        # JS 문자열로 이스케이프 (백슬래시, 따옴표, 개행)
        js_html = entry_html.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")
        js = f"""
        var chat = document.getElementById('chat');
        var div = document.createElement('div');
        div.innerHTML = '{js_html}';
        while(div.firstChild) chat.appendChild(div.firstChild);
        window.scrollTo(0, document.body.scrollHeight);
        """
        self._webview.evaluateJavaScript_completionHandler_(js, None)


    def _show_suggestions(self, suggestions, coordinator=None):
        """빠른 답장을 WKWebView 내부에 HTML로 추가"""
        if self._suggest_area_built or not self.panel:
            return
        self._suggest_area_built = True
        self._suggestions = suggestions

        if self._webview:
            # WKWebView에 JS로 제안 버튼 추가
            btns_html = ""
            for s in suggestions:
                kr_esc = html_mod.escape(s["kr"])
                jp_esc = html_mod.escape(s["jp"])
                btns_html += f'<div class="suggest-btn" onclick="pickSuggest(this)" data-text="{kr_esc}" data-orig="KR: {kr_esc}">KR: {kr_esc}</div>'
                btns_html += f'<div class="suggest-btn" onclick="pickSuggest(this)" data-text="{jp_esc}" data-orig="JP: {jp_esc}">JP: {jp_esc}</div>'

            is_dark = self._detect_theme()
            c = self._theme_colors(is_dark)
            style = f'''
            .suggest-section {{ margin-top: -8px; padding: 8px 0 16px; margin-bottom: 8px; border-bottom: 1px solid {c["divider"]}; }}
            .suggest-label {{
                font-size: 11px; font-weight: 600; color: {c["fg_dim"]};
                text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;
            }}
            .suggest-btn {{
                background: {c["card_bg"]}; border: 1px solid {c["border"]};
                border-radius: 10px; padding: 10px 14px; margin-bottom: 6px;
                font-size: 13px; cursor: pointer; color: {c["fg"]};
            }}
            .suggest-btn:hover {{ background: rgba(128,128,128,0.15); }}
            '''

            label_html = '<div class="suggest-label">빠른 답장</div>'
            js_html = f'<div class="suggest-section" id="suggestions">{label_html}{btns_html}</div>'
            js_html = js_html.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")
            style_js = style.replace("\n", " ").replace("'", "\\'")
            pick_fn = "function pickSuggest(el){var bs=el.parentElement.getElementsByClassName('suggest-btn');for(var i=0;i<bs.length;i++){bs[i].innerText=bs[i].dataset.orig}el.innerText='\\u2713 '+el.dataset.orig;var a=document.createElement('textarea');a.value=el.dataset.text;document.body.appendChild(a);a.select();document.execCommand('copy');document.body.removeChild(a)}"
            js = (
                "var style=document.createElement('style');"
                f"style.textContent='{style_js}';"
                "document.head.appendChild(style);"
                f"{pick_fn};"
                "var chat=document.getElementById('chat');"
                "var div=document.createElement('div');"
                f"div.innerHTML='{js_html}';"
                "while(div.firstChild)chat.appendChild(div.firstChild);"
                "window.scrollTo(0,document.body.scrollHeight);"
            )
            self._webview.evaluateJavaScript_completionHandler_(js, None)

    def _hide_suggestions(self):
        """빠른 답장 영역 제거"""
        if not self._suggest_area_built or not self.panel or not self._webview:
            return

        js = """
        var el = document.getElementById('suggestions');
        if(el) el.remove();
        """
        self._webview.evaluateJavaScript_completionHandler_(js, None)

        self._suggest_area_built = False

        if self._suggest_btn:
            self._suggest_btn.setTitle_("💬 빠른 답장")

    def _create_panel(self, w, h):
        screen = active_screen().visibleFrame()
        x = screen.origin.x + (screen.size.width - w) / 2
        y = screen.origin.y + (screen.size.height - h) / 2 + 50

        self.panel = NSPanel.alloc().initWithContentRect_styleMask_backing_defer_(
            ((x, y), (w, h)),
            NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable | NSWindowStyleMaskFullSizeContentView,
            NSBackingStoreBuffered, False
        )
        self.panel.setLevel_(NSFloatingWindowLevel)
        self.panel.setHidesOnDeactivate_(False)
        self.panel.setTitle_("팝업 번역기")
        self.panel.setTitlebarAppearsTransparent_(True)
        self.panel.setMovableByWindowBackground_(True)

        # 반투명 배경 (NSVisualEffectView)
        vfx = AppKit.NSVisualEffectView.alloc().initWithFrame_(((0, 0), (w, h)))
        vfx.setAutoresizingMask_(NSViewWidthSizable | NSViewHeightSizable)
        vfx.setBlendingMode_(0)  # NSVisualEffectBlendingModeBehindWindow
        vfx.setMaterial_(3)      # NSVisualEffectMaterialHUDWindow
        vfx.setState_(1)         # NSVisualEffectStateActive
        self.panel.contentView().addSubview_positioned_relativeTo_(vfx, -1, None)  # 맨 뒤에 배치
        self.panel.setBackgroundColor_(NSColor.clearColor())
        self.panel.setOpaque_(False)

    def _close(self):
        if self.panel:
            self.panel.orderOut_(None)
            self.panel = None
            self._result_input = None
            self._input_delegate = None
            self._lang_popup = None


# ─── Coordinator (NSObject 서브클래스 — objc 셀렉터 호출용) ───
class Coordinator(NSObject):

    def init(self):
        self = objc.super(Coordinator, self).init()
        if self is None:
            return None
        self._window = TranslatorWindow()
        self._input_window = TranslatorInputWindow()
        self._status_bar = StatusBarItem.alloc().init()
        return self

    def triggerTranslation_(self, timer):
        log("단축키 감지 → 선택 텍스트 복사 중…")
        old_clip = get_clipboard()
        old_text = old_clip[0] if isinstance(old_clip, tuple) else (old_clip or "")
        log(f"기존 클립보드: {old_text[:40] if old_text else '(비어있음)'}…")
        copy_selection()

        def do_copy_and_translate():
            # 클립보드 변경 대기 (최대 2초)
            clip = ""
            for i in range(10):
                time.sleep(0.2)
                clip = get_clipboard()
                cur_text = clip[0] if isinstance(clip, tuple) else (clip or "")
                if cur_text and cur_text != old_text:
                    log(f"클립보드 변경 감지 ({(i+1)*0.2:.1f}초)")
                    break
            else:
                clip = get_clipboard()
                log("클립보드 변경 없음, 기존 내용 사용")

            # 클립보드 유형 판단
            is_image = isinstance(clip, tuple) and clip[0] == "__IMAGE__"
            is_table = isinstance(clip, tuple) and not is_image

            if is_image:
                image_data = clip[1]
                log(f"이미지 감지 ({len(image_data)} bytes)")
            elif is_table:
                text, table_html = clip
                table_html = _clean_table_html(table_html)
                log(f"HTML 테이블 감지 (병합 셀 포함 가능)")
            else:
                text = clip or ""
                table_html = None

            if not is_image and not text:
                log("클립보드가 비어있음")
                self.performSelectorOnMainThread_withObject_waitUntilDone_(
                    objc.selector(None, selector=b"resetStatus:", signature=b"v@:@"),
                    None, False
                )
                return

            if not is_image:
                log(f"클립보드 텍스트: {text[:80]}{'…' if len(text) > 80 else ''}")

            # 메뉴바에 번역 중 표시
            self.performSelectorOnMainThread_withObject_waitUntilDone_(
                objc.selector(None, selector=b"setStatusTranslating:", signature=b"v@:@"),
                None, False
            )

            if is_image:
                result = translate_image(image_data)
                # [원문] / [번역] 형식 파싱
                original_text = ""
                translated_text = result
                if "[원문]" in result and "[번역]" in result:
                    parts = result.split("[번역]")
                    original_text = parts[0].replace("[원문]", "").strip()
                    translated_text = parts[1].strip()
                self.performSelectorOnMainThread_withObject_waitUntilDone_(
                    objc.selector(None, selector=b"showResult:", signature=b"v@:@"),
                    {
                        "original": original_text or "(이미지에서 추출)",
                        "translated": translated_text,
                        "is_table": False,
                        "original_html": None,
                        "is_image": True,
                        "image_data": image_data,
                    }, False
                )
            else:
                result = translate(text, table_html=table_html)
                log(f"번역 결과: {result[:80]}{'…' if len(result) > 80 else ''}")
                self.performSelectorOnMainThread_withObject_waitUntilDone_(
                    objc.selector(None, selector=b"showResult:", signature=b"v@:@"),
                    {
                        "original": text,
                        "translated": result,
                        "is_table": is_table,
                        "original_html": table_html if is_table else None,
                    }, False
                )
        threading.Thread(target=do_copy_and_translate, daemon=True).start()

    def toggleInputWindow_(self, sender):
        self._input_window.toggle(self)

    def toggleResultWindow_(self, sender):
        """좌클릭 → 결과창 표시/토글"""
        if self._window.panel and self._window.panel.isVisible():
            self._window.panel.orderOut_(None)
        else:
            # 기존 결과가 없으면 빈 창 생성
            if not self._window.panel:
                self._window._create_panel(460, 520)
                content = self._window.panel.contentView()
                is_dark = self._window._detect_theme()
                self._window._build_text_layout(content, [], 520, 460 - 40, self, is_dark)
            self._window.panel.orderFrontRegardless()
            NSApplication.sharedApplication().activateIgnoringOtherApps_(True)
            if self._window._result_input:
                self._window.panel.makeFirstResponder_(self._window._result_input)

    def onInputSubmit_(self, text):
        text = text.strip()
        if not text:
            return
        target_lang = self._input_window.selected_language()
        _defaults.setObject_forKey_(target_lang, "target_language")
        log(f"입력창 번역 요청 ({target_lang}): {text[:80]}{'…' if len(text) > 80 else ''}")
        self._input_window.clear_and_close()
        self._status_bar.set_status("⏳ 번역 중…")
        # 기존 결과창이 있으면 로딩 표시
        if self._window.panel and self._window._webview:
            self._window.show_loading(text)
            self._window.panel.orderFrontRegardless()
            NSApplication.sharedApplication().activateIgnoringOtherApps_(True)

        def do_translate():
            result = translate(text, target_lang=target_lang)
            log(f"번역 결과: {result[:80]}{'…' if len(result) > 80 else ''}")
            self.performSelectorOnMainThread_withObject_waitUntilDone_(
                objc.selector(None, selector=b"showResult:", signature=b"v@:@"),
                {
                    "original": text,
                    "translated": result,
                    "is_table": False,
                    "original_html": None,
                }, False
            )
        threading.Thread(target=do_translate, daemon=True).start()

    def onResultInputSubmit_(self, text):
        """결과창 하단 입력 필드에서 번역 요청"""
        text = text.strip()
        if not text:
            return
        # 결과창 언어 팝업에서 선택된 언어 사용
        if self._window._lang_popup:
            target_lang = str(self._window._lang_popup.titleOfSelectedItem())
            _defaults.setObject_forKey_(target_lang, "target_language")
        else:
            target_lang = str(_defaults.stringForKey_("target_language") or TARGET_LANG)
        log(f"결과창 추가 번역 ({target_lang}): {text[:80]}{'…' if len(text) > 80 else ''}")
        self._status_bar.set_status("⏳ 번역 중…")
        # 입력 필드 비우고 로딩 표시
        if self._window._result_input:
            self._window._result_input.setStringValue_("")
        self._window.show_loading(text)

        def do_translate():
            result = translate(text, target_lang=target_lang)
            log(f"번역 결과: {result[:80]}{'…' if len(result) > 80 else ''}")
            self.performSelectorOnMainThread_withObject_waitUntilDone_(
                objc.selector(None, selector=b"showResult:", signature=b"v@:@"),
                {
                    "original": text,
                    "translated": result,
                    "is_table": False,
                    "original_html": None,
                }, False
            )
        threading.Thread(target=do_translate, daemon=True).start()

    def setStatusTranslating_(self, _):
        self._status_bar.set_status("⏳ 번역 중…")

    # ─── 버튼 핸들러 ─────────────────────────────────────────
    def onClearChat_(self, sender):
        """채팅 기록 초기화"""
        self._window._chat_history = []
        self._window._suggest_area_built = False
        if self._window._webview:
            self._window._webview.evaluateJavaScript_completionHandler_(
                "document.getElementById('chat').innerHTML='';", None
            )
        log("채팅 기록 초기화")

    def onPronunciationFromJS_(self, original_text):
        """WKWebView JS에서 호출 — 한국어 발음 생성"""
        original = str(original_text).strip()
        if not original:
            return
        log(f"한국어 발음 요청: {original[:40]}")

        def do_pron():
            try:
                pron = korean_pronunciation(original)
                log(f"한국어 발음: {pron}")
                self.performSelectorOnMainThread_withObject_waitUntilDone_(
                    objc.selector(None, selector=b"showPronunciation:", signature=b"v@:@"),
                    {"text": original, "pron": pron}, False
                )
            except Exception as e:
                log(f"발음 생성 오류: {e}")
                self.performSelectorOnMainThread_withObject_waitUntilDone_(
                    objc.selector(None, selector=b"showPronunciation:", signature=b"v@:@"),
                    {"text": original, "pron": ""}, False
                )
        threading.Thread(target=do_pron, daemon=True).start()

    def showPronunciation_(self, info):
        """발음 결과를 해당 원문 카드에 추가"""
        pron = str(info["pron"]) if info.get("pron") else ""
        pron = pron.strip()
        log(f"showPronunciation_ 호출, pron 길이: {len(pron)}")
        if not self._window._webview:
            log("webview 없음")
            return
        # 로딩 중인 버튼을 찾아서 해당 카드에 발음 삽입
        pron_escaped = pron.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "<br>") if pron else ""
        if pron:
            js = (
                "var btn=document.querySelector('.pron-btn.loading');"
                "if(btn){"
                "var card=btn.closest('.card.orig');"
                "if(card && !card.querySelector('.pron-area')){"
                "var p=document.createElement('div');"
                "p.className='pron-area';"
                f"p.innerHTML='🔤 {pron_escaped}';"
                "card.appendChild(p);"
                "}"
                "btn.classList.remove('loading');btn.innerText='발음';"
                "}"
                "window.scrollTo(0,document.body.scrollHeight);"
            )
        else:
            js = (
                "var btn=document.querySelector('.pron-btn.loading');"
                "if(btn){btn.classList.remove('loading');btn.innerText='발음';}"
            )
        self._window._webview.evaluateJavaScript_completionHandler_(js, None)

    def onRequestSuggest_(self, sender):
        if self._window._suggest_area_built:
            return
        log("빠른 답장 버튼 클릭")
        sender.setTitle_("💬 생성 중…")
        sender.setEnabled_(False)
        self._status_bar.set_status("💬 빠른 답장 생성 중…")
        original = self._window._original
        translated = self._window._translated
        def do_suggest():
            try:
                suggestions = suggest_replies(original, translated)
                log(f"빠른 답장 결과: {suggestions}")
                self.performSelectorOnMainThread_withObject_waitUntilDone_(
                    objc.selector(None, selector=b"showSuggestions:", signature=b"v@:@"),
                    suggestions if suggestions else [], False
                )
            except Exception as e:
                log(f"빠른 답장 오류: {e}")
                self.performSelectorOnMainThread_withObject_waitUntilDone_(
                    objc.selector(None, selector=b"showSuggestions:", signature=b"v@:@"),
                    [], False
                )
        threading.Thread(target=do_suggest, daemon=True).start()

    def showResult_(self, info):
        original = str(info["original"])
        translated = str(info["translated"])
        is_table = bool(info.get("is_table", False))
        original_html = info.get("original_html")
        is_image = bool(info.get("is_image", False))
        image_data = info.get("image_data")
        self._window.show_result(
            original, translated, coordinator=self,
            is_table=is_table,
            original_html=str(original_html) if original_html else None,
            is_image=is_image,
            image_data=bytes(image_data) if image_data else None,
        )
        self._status_bar.reset_status()
        # 번역 후 클립보드 비우기 (이전 이미지/텍스트가 다음 번역에 영향 방지)
        pb = AppKit.NSPasteboard.generalPasteboard()
        pb.clearContents()

    def showSuggestions_(self, suggestions):
        log(f"showSuggestions_ 호출, {len(suggestions) if suggestions else 0}개")
        self._window._suggest_btn.setTitle_("💬 빠른 답장")
        self._window._suggest_btn.setEnabled_(True)
        if suggestions:
            self._window._show_suggestions(suggestions, coordinator=self)
        self._status_bar.reset_status()

    def resetStatus_(self, _):
        self._status_bar.reset_status()

    def onSettings_(self, sender):
        global _selected_gemini_model
        log("설정 클릭")
        from AppKit import NSAlert, NSTextField, NSPopUpButton, NSView, NSFont

        alert = NSAlert.alloc().init()
        alert.setMessageText_("설정")

        current_key = _get_api_key()
        if current_key:
            masked = current_key[:4] + "…" + current_key[-4:]
            alert.setInformativeText_(f"현재 키: {masked}\n새 키를 입력하면 변경, 비워두면 유지됩니다.")
        else:
            alert.setInformativeText_("Gemini API 키를 입력하세요.\nhttps://aistudio.google.com/apikey 에서 발급")

        # 컨테이너 뷰 (API 키 입력 + 모델 선택)
        container = NSView.alloc().initWithFrame_(((0, 0), (300, 62)))

        # 모델 선택 라벨 + 드롭다운 (상단)
        model_label = NSTextField.labelWithString_("모델:")
        model_label.setFont_(NSFont.systemFontOfSize_(12))
        model_label.setFrame_(((0, 38), (40, 20)))
        container.addSubview_(model_label)

        model_popup = NSPopUpButton.alloc().initWithFrame_pullsDown_(((42, 36), (256, 24)), False)
        for m in GEMINI_MODELS:
            model_popup.addItemWithTitle_(m)
        model_popup.selectItemWithTitle_(_selected_gemini_model)
        container.addSubview_(model_popup)

        # API 키 입력 (하단)
        key_label = NSTextField.labelWithString_("API 키:")
        key_label.setFont_(NSFont.systemFontOfSize_(12))
        key_label.setFrame_(((0, 6), (46, 20)))
        container.addSubview_(key_label)

        input_field = NSTextField.alloc().initWithFrame_(((48, 4), (250, 24)))
        input_field.setPlaceholderString_("새 키 입력 (비워두면 유지)…")
        container.addSubview_(input_field)

        alert.setAccessoryView_(container)
        alert.addButtonWithTitle_("저장")
        alert.addButtonWithTitle_("취소")
        if current_key:
            alert.addButtonWithTitle_("키 삭제")
        alert.window().setInitialFirstResponder_(input_field)

        response = alert.runModal()
        if response == AppKit.NSAlertFirstButtonReturn:
            # API 키 처리
            new_key = str(input_field.stringValue()).strip()
            if new_key:
                _keychain_save(new_key)
                _reset_gemini()
                log("API 키 저장 완료 (Keychain)")

            # 모델 변경 처리
            new_model = str(model_popup.titleOfSelectedItem())
            if new_model != _selected_gemini_model:
                _selected_gemini_model = new_model
                _defaults.setObject_forKey_(new_model, "geminiModel")
                _reset_gemini()
                log(f"모델 변경: {new_model}")
        elif response == AppKit.NSAlertThirdButtonReturn:
            _keychain_delete()
            _reset_gemini()
            log("API 키 삭제됨")

    def onAbout_(self, sender):
        log("About 클릭")
        from AppKit import NSAlert, NSInformationalAlertStyle
        alert = NSAlert.alloc().init()
        alert.setMessageText_("팝업번역기")
        alert.setInformativeText_(
            "버전 0.9\n\n"
            "macOS 팝업 번역기\n"
            "일본어 → 한국어 (Gemini / Claude)\n\n"
            "⌘+Ctrl+T: 번역"
        )
        alert.setAlertStyle_(NSInformationalAlertStyle)
        # About 아이콘 설정
        icon_path = os.path.join(os.path.dirname(__file__), "icon.png")
        icon_image = AppKit.NSImage.alloc().initWithContentsOfFile_(icon_path)
        if icon_image:
            icon_image.setSize_((64, 64))
            alert.setIcon_(icon_image)
        alert.runModal()

    def onQuit_(self, sender):
        log("메뉴바 종료 클릭")
        AppKit.NSApp.terminate_(None)

    def initStatusBar_(self, timer):
        message = str(timer.userInfo()) if hasattr(timer, 'userInfo') else str(timer)
        self._status_bar.setupWithMessage_coordinator_(message, coordinator=self)

    def keepAlive_(self, timer):
        pass  # SIGINT가 메인 런루프에 전달되도록 주기적으로 깨움


# ─── Main ─────────────────────────────────────────────────────
def main():
    import Quartz

    app = NSApplication.sharedApplication()
    app.setActivationPolicy_(AppKit.NSApplicationActivationPolicyAccessory)

    # Edit 메뉴 추가 (⌘+V 붙여넣기 등 기본 텍스트 편집 지원)
    menubar = AppKit.NSMenu.alloc().init()
    edit_menu_item = AppKit.NSMenuItem.alloc().init()
    menubar.addItem_(edit_menu_item)
    edit_menu = AppKit.NSMenu.alloc().initWithTitle_("Edit")
    for title, action, key in [
        ("Cut", "cut:", "x"),
        ("Copy", "copy:", "c"),
        ("Paste", "paste:", "v"),
        ("Select All", "selectAll:", "a"),
        ("Undo", "undo:", "z"),
    ]:
        item = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(title, action, key)
        edit_menu.addItem_(item)
    edit_menu_item.setSubmenu_(edit_menu)
    app.setMainMenu_(menubar)

    coordinator = Coordinator.alloc().init()

    # macOS 가상 키코드: t=17
    VK_T = 17
    CMD_CTRL = Quartz.kCGEventFlagMaskCommand | Quartz.kCGEventFlagMaskControl

    def cg_event_callback(proxy, event_type, event, refcon):
        keycode = Quartz.CGEventGetIntegerValueField(event, Quartz.kCGKeyboardEventKeycode)
        flags = Quartz.CGEventGetFlags(event)
        if (flags & CMD_CTRL) == CMD_CTRL and keycode == VK_T:
            log("⌘+Ctrl+T 감지 → 번역 시작")
            coordinator.performSelectorOnMainThread_withObject_waitUntilDone_(
                objc.selector(coordinator.triggerTranslation_, signature=b"v@:@"),
                None, False
            )
        return event

    # CGEventTap 생성
    tap = Quartz.CGEventTapCreate(
        Quartz.kCGSessionEventTap,
        Quartz.kCGHeadInsertEventTap,
        Quartz.kCGEventTapOptionListenOnly,
        Quartz.CGEventMaskBit(Quartz.kCGEventKeyDown),
        cg_event_callback,
        None
    )

    if tap is None:
        log("CGEventTap 생성 실패! 접근성 권한을 확인하세요.")
        log("시스템 설정 → 개인정보 보호 및 보안 → 접근성 → VSCode/Terminal 체크")
        return

    log("CGEventTap 생성 성공")

    # 런루프 소스로 등록
    run_loop_source = Quartz.CFMachPortCreateRunLoopSource(None, tap, 0)
    Quartz.CFRunLoopAddSource(
        Quartz.CFRunLoopGetMain(),
        run_loop_source,
        Quartz.kCFRunLoopCommonModes
    )
    Quartz.CGEventTapEnable(tap, True)
    log("CGEventTap 활성화 완료")

    log("🌐 macOS 팝업 번역기 시작 (⌘+Ctrl+T: 번역 / Ctrl+C: 종료)")

    # Ctrl+C (SIGINT) 로 종료 가능하도록
    def sigint_handler(sig, frame):
        log("Ctrl+C → 종료")
        AppKit.NSApp.terminate_(None)
    signal.signal(signal.SIGINT, sigint_handler)

    # SIGINT가 메인 스레드에 전달되도록 주기적 타이머 설정
    NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
        1.0, coordinator,
        objc.selector(coordinator.keepAlive_, signature=b"v@:@"),
        None, True
    )

    # 메뉴바 상태 아이콘 초기화 (메인 런루프 시작 후 실행되도록)
    NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
        0.3, coordinator,
        objc.selector(coordinator.initStatusBar_, signature=b"v@:@"),
        "🌐 번역기 실행 중 (⌘+Ctrl+T)", False
    )

    # NSApp 메인 루프 실행
    AppKit.NSApp.run()

if __name__ == "__main__":
    main()
