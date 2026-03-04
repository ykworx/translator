#!/usr/bin/env python3
"""macOS 팝업 번역기 — Claude CLI / Gemini API (PyObjC 네이티브 UI)"""

import html as html_mod
import os
import signal
import subprocess
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
    NSViewWidthSizable, NSViewHeightSizable, NSViewMinYMargin, NSViewMaxYMargin,
    NSBezelStyleRounded,
)
from pynput.keyboard import Key, Controller as KBController

TARGET_LANG = "한국어"

# ─── Model Selection ─────────────────────────────────────────
MODELS = ["gemini", "claude"]
_current_model_idx = [0]  # 기본: gemini

def get_current_model():
    return MODELS[_current_model_idx[0]]

# Gemini client (lazy init)
_gemini_model = None
def _get_gemini():
    global _gemini_model
    if _gemini_model is None:
        import google.generativeai as genai
        api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY", "")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY 또는 GOOGLE_API_KEY 환경변수를 설정하세요")
        genai.configure(api_key=api_key)
        _gemini_model = genai.GenerativeModel("gemini-2.0-flash")
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
def _call_model(prompt, timeout=60):
    """현재 선택된 모델로 프롬프트를 전송하고 응답 텍스트를 반환"""
    model = get_current_model()
    if model == "gemini":
        resp = _get_gemini().generate_content(prompt)
        return resp.text.strip()
    else:
        result = subprocess.run(
            ["claude", "-p", "--model", "haiku", prompt],
            capture_output=True, text=True, timeout=timeout
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "Claude CLI 실행 실패")
        return result.stdout.strip()

# ─── Translation ──────────────────────────────────────────────
def translate(text, table_html=None):
    """텍스트 번역. table_html이 있으면 HTML 구조를 보존하며 번역."""
    if table_html:
        prompt = (
            f"Translate ALL Japanese text in the following HTML table to {TARGET_LANG}.\n"
            "IMPORTANT RULES:\n"
            "- Translate ALL Japanese text to Korean, including technical terms\n"
            "- Keep ALL HTML tags and attributes (rowspan, colspan, etc.) EXACTLY as-is\n"
            "- Do NOT translate: product IDs (e.g. AF-01), version numbers, URLs, English words\n"
            "- Do NOT add, remove, or modify any HTML tags\n"
            "- Output ONLY the translated HTML table, nothing else\n\n"
            f"{table_html}"
        )
    else:
        prompt = (
            f"Translate the following text to {TARGET_LANG}. "
            "Output ONLY the translated text, nothing else.\n\n"
            f"{text}"
        )
    try:
        mode = "HTML 테이블" if table_html else "텍스트"
        log(f"[{get_current_model()}] 번역 중… ({mode}, 길이: {len(table_html or text)}자)")
        result = _call_model(prompt, timeout=60)
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
    except subprocess.TimeoutExpired:
        log("번역 시간 초과 (60초)")
        return "[오류] 번역 시간 초과 (60초)"
    except Exception as e:
        log(f"번역 오류: {e}")
        return f"[오류] {e}"

def translate_image(image_data):
    """이미지 속 일본어 텍스트를 추출하고 번역 (Gemini Vision)"""
    model = get_current_model()
    if model != "gemini":
        return "[오류] 이미지 번역은 Gemini만 지원합니다. 메뉴바에서 GEMINI로 전환하세요."
    try:
        log(f"[gemini] 이미지 번역 중… ({len(image_data)} bytes)")
        gemini = _get_gemini()
        image_part = {"mime_type": "image/png", "data": image_data}
        prompt = (
            f"This image contains Japanese text. Do the following:\n"
            f"1. Extract ALL text from the image\n"
            f"2. Translate ALL Japanese text to {TARGET_LANG}\n\n"
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
        log(f"[{get_current_model()}] 빠른 답장 생성 중…")
        raw = _call_model(prompt, timeout=30)
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

# ─── Menu Bar Status Item ─────────────────────────────────────
class StatusBarItem:
    """macOS 메뉴바 상태 아이콘"""
    def __init__(self):
        self._status_item = None
        self._default_title = ""
        self._coordinator = None
        self._model_items = {}

    def show(self, message, coordinator=None):
        self._default_title = "🌐"
        if coordinator:
            self._coordinator = coordinator
        if self._status_item:
            return

        sb = AppKit.NSStatusBar.systemStatusBar()
        self._status_item = sb.statusItemWithLength_(AppKit.NSVariableStatusItemLength)

        # 아이콘 이미지 로드
        icon_path = os.path.join(os.path.dirname(__file__), "icon.png")
        icon_image = AppKit.NSImage.alloc().initWithContentsOfFile_(icon_path)
        if icon_image:
            icon_image.setSize_((18, 18))
            icon_image.setTemplate_(False)
            self._status_item.button().setImage_(icon_image)
        else:
            self._status_item.button().setTitle_("🌐")
        self._status_item.button().setToolTip_(message)

        self._build_menu()

    def _build_menu(self):
        menu = AppKit.NSMenu.alloc().init()

        # 상태 표시 (비활성)
        status_item = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
            "⌘+Ctrl+T: 팝업번역기", None, "")
        status_item.setEnabled_(False)
        menu.addItem_(status_item)

        menu.addItem_(AppKit.NSMenuItem.separatorItem())

        # 모델 선택
        for m in MODELS:
            item = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
                m.upper(), objc.selector(self._coordinator.onSelectModel_, signature=b"v@:@"), "")
            item.setTarget_(self._coordinator)
            if m == get_current_model():
                item.setState_(1)  # NSOnState
            self._model_items[m] = item
            menu.addItem_(item)

        menu.addItem_(AppKit.NSMenuItem.separatorItem())

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

        self._status_item.setMenu_(menu)

    def _update_model_check(self):
        current = get_current_model()
        for m, item in self._model_items.items():
            item.setState_(1 if m == current else 0)

    def set_status(self, message):
        """메뉴바 타이틀을 임시 변경"""
        if self._status_item:
            self._status_item.button().setTitle_(message)

    def reset_status(self):
        """메뉴바 타이틀을 기본으로 복원"""
        if self._status_item:
            self._status_item.button().setTitle_(self._default_title)

# ─── Result Window ────────────────────────────────────────────
class TranslatorWindow:
    def __init__(self):
        self.panel = None

    def show_result(self, original, translated, coordinator=None, is_table=False, original_html=None, is_image=False, image_data=None):
        self._close()
        self._is_table = is_table
        self._is_image = is_image
        self._original_html = original_html
        panel_w = 900 if is_table else (600 if is_image else 520)
        panel_h = 800 if is_table else (600 if is_image else 380)
        self._create_panel(panel_w, panel_h)
        if is_table:
            # 타이틀(38) + 라벨(18) + 원문(200) + gap(8) + 라벨(18) + 번역최소(200) + 버튼영역(56)
            min_h = 38 + 18 + 200 + 8 + 18 + 200 + 56
            self.panel.setMinSize_((500, min_h))
        else:
            self.panel.setMinSize_((400, 300))
        self._original = original
        self._translated = translated
        self._suggest_area_built = False

        content = self.panel.contentView()
        content.setAutoresizesSubviews_(True)
        w = panel_w - 40

        if is_table:
            # 테이블 모드 레이아웃 (위→아래)
            # ┌──────────────────────┐ ← panel_h
            # │ titlebar (38px)      │
            # ├──────────────────────┤ ← panel_h - 38
            # │ "원문" 라벨 (18px)    │
            # │ 원문 테이블 (200px)   │ ← 고정
            # │ gap (8px)            │
            # │ "번역 결과" 라벨 (18px)│
            # │ 번역 테이블 (가변)    │ ← 리사이즈 시 이 영역만 변함
            # │ gap (8px)            │
            # │ 버튼 (32px)          │
            # │ margin (16px)        │
            # └──────────────────────┘
            orig_h = 200
            btn_area = 56     # 버튼(32) + 하단 여백(16) + gap(8)
            top_margin = 38   # 타이틀바

            # 원문 라벨
            lbl1_y = panel_h - top_margin - 18
            lbl1 = NSTextField.labelWithString_("원문")
            lbl1.setFont_(NSFont.systemFontOfSize_(11))
            lbl1.setTextColor_(FG_DIM)
            lbl1.setFrame_(((20, lbl1_y), (w, 18)))
            lbl1.setBackgroundColor_(NSColor.clearColor())
            lbl1.setAutoresizingMask_(NSViewWidthSizable | NSViewMinYMargin)
            content.addSubview_(lbl1)

            # 원문 테이블 (고정 높이, 상단 고정)
            orig_y = lbl1_y - orig_h
            orig_html = getattr(self, '_original_html', None)
            orig_wv = self._make_table_view(
                orig_html or original,
                ((20, orig_y), (w, orig_h)),
                is_html=bool(orig_html)
            )
            orig_wv.setAutoresizingMask_(NSViewWidthSizable | NSViewMinYMargin)
            content.addSubview_(orig_wv)

            # 번역 결과 라벨 (원문 아래, 상단 고정)
            lbl2_y = orig_y - 8 - 18
            lbl2 = NSTextField.labelWithString_("번역 결과")
            lbl2.setFont_(NSFont.systemFontOfSize_(11))
            lbl2.setTextColor_(FG_DIM)
            lbl2.setFrame_(((20, lbl2_y), (w, 18)))
            lbl2.setBackgroundColor_(NSColor.clearColor())
            lbl2.setAutoresizingMask_(NSViewWidthSizable | NSViewMinYMargin)
            content.addSubview_(lbl2)

            # 번역 테이블 (나머지 공간, 리사이즈 가능)
            trans_y = btn_area
            trans_h = lbl2_y - trans_y
            trans_is_html = "<table" in translated.lower()
            trans_wv = self._make_table_view(
                translated,
                ((20, trans_y), (w, trans_h)),
                is_html=trans_is_html
            )
            trans_wv.setAutoresizingMask_(NSViewWidthSizable | NSViewHeightSizable)
            content.addSubview_(trans_wv)
        elif is_image and image_data:
            # 이미지 모드: 상단 원본 이미지 + 하단 번역 텍스트
            from Foundation import NSData
            img_h = 250
            btn_area = 56
            top_margin = 38

            lbl1_y = panel_h - top_margin - 18
            lbl1 = NSTextField.labelWithString_("원본 이미지")
            lbl1.setFont_(NSFont.systemFontOfSize_(11))
            lbl1.setTextColor_(FG_DIM)
            lbl1.setFrame_(((20, lbl1_y), (w, 18)))
            lbl1.setBackgroundColor_(NSColor.clearColor())
            lbl1.setAutoresizingMask_(NSViewWidthSizable | NSViewMinYMargin)
            content.addSubview_(lbl1)

            img_y = lbl1_y - img_h
            ns_data = NSData.dataWithBytes_length_(image_data, len(image_data))
            ns_image = AppKit.NSImage.alloc().initWithData_(ns_data)
            # 실제 이미지 크기로 NSImageView 생성 (스크롤 가능)
            img_size = ns_image.size()
            real_w = max(int(img_size.width), w)
            real_h = max(int(img_size.height), img_h)
            img_view = AppKit.NSImageView.alloc().initWithFrame_(((0, 0), (real_w, real_h)))
            img_view.setImage_(ns_image)
            img_view.setImageScaling_(0)  # NSImageScaleNone — 원본 크기
            img_view.setImageAlignment_(6)  # NSImageAlignTopLeft
            # NSScrollView로 감싸기
            img_scroll = NSScrollView.alloc().initWithFrame_(((20, img_y), (w, img_h)))
            img_scroll.setHasVerticalScroller_(True)
            img_scroll.setHasHorizontalScroller_(True)
            img_scroll.setBorderType_(0)
            img_scroll.setDocumentView_(img_view)
            img_scroll.setBackgroundColor_(SURFACE)
            img_scroll.setAutoresizingMask_(NSViewWidthSizable | NSViewMinYMargin)
            content.addSubview_(img_scroll)

            lbl2_y = img_y - 8 - 18
            lbl2 = NSTextField.labelWithString_("번역 결과")
            lbl2.setFont_(NSFont.systemFontOfSize_(11))
            lbl2.setTextColor_(FG_DIM)
            lbl2.setFrame_(((20, lbl2_y), (w, 18)))
            lbl2.setBackgroundColor_(NSColor.clearColor())
            lbl2.setAutoresizingMask_(NSViewWidthSizable | NSViewMinYMargin)
            content.addSubview_(lbl2)

            trans_y = btn_area
            trans_h = lbl2_y - trans_y
            trans_scroll = self._make_text_area(translated, ((20, trans_y), (w, trans_h)))
            trans_scroll.setAutoresizingMask_(NSViewWidthSizable | NSViewHeightSizable)
            content.addSubview_(trans_scroll)
            self._trans_scroll = trans_scroll

            min_h = top_margin + 18 + img_h + 8 + 18 + 120 + btn_area
            self.panel.setMinSize_((400, min_h))
        else:
            # 일반 텍스트 모드
            lbl1 = NSTextField.labelWithString_("원문")
            lbl1.setFont_(NSFont.systemFontOfSize_(11))
            lbl1.setTextColor_(FG_DIM)
            lbl1.setFrame_(((20, 316), (w, 18)))
            lbl1.setBackgroundColor_(NSColor.clearColor())
            lbl1.setAutoresizingMask_(NSViewWidthSizable | NSViewMinYMargin)
            content.addSubview_(lbl1)

            orig_scroll = self._make_text_area(original, ((20, 196), (w, 115)))
            orig_scroll.setAutoresizingMask_(NSViewWidthSizable | NSViewMinYMargin)
            content.addSubview_(orig_scroll)

            lbl2 = NSTextField.labelWithString_("번역 결과")
            lbl2.setFont_(NSFont.systemFontOfSize_(11))
            lbl2.setTextColor_(FG_DIM)
            lbl2.setFrame_(((20, 168), (w, 18)))
            lbl2.setBackgroundColor_(NSColor.clearColor())
            lbl2.setAutoresizingMask_(NSViewWidthSizable | NSViewMinYMargin)
            content.addSubview_(lbl2)

            trans_scroll = self._make_text_area(translated, ((20, 58), (w, 105)))
            trans_scroll.setAutoresizingMask_(NSViewWidthSizable | NSViewHeightSizable)
            content.addSubview_(trans_scroll)
            self._trans_scroll = trans_scroll

        # 하단 버튼들
        copy_btn = NSButton.alloc().initWithFrame_(((20, 16), (100, 32)))
        copy_btn.setTitle_("번역 복사")
        copy_btn.setBezelStyle_(NSBezelStyleRounded)
        copy_btn.setTarget_(coordinator)
        copy_btn.setAction_(objc.selector(coordinator.onCopyTranslation_, signature=b"v@:@"))
        copy_btn.setAutoresizingMask_(NSViewMaxYMargin)
        content.addSubview_(copy_btn)

        suggest_btn = NSButton.alloc().initWithFrame_(((130, 16), (120, 32)))
        suggest_btn.setTitle_("빠른 답장")
        suggest_btn.setBezelStyle_(NSBezelStyleRounded)
        suggest_btn.setTarget_(coordinator)
        suggest_btn.setAction_(objc.selector(coordinator.onRequestSuggest_, signature=b"v@:@"))
        suggest_btn.setAutoresizingMask_(NSViewMaxYMargin)
        content.addSubview_(suggest_btn)
        self._suggest_btn = suggest_btn

        self.panel.orderFrontRegardless()
        NSApplication.sharedApplication().activateIgnoringOtherApps_(True)

    def _show_suggestions(self, suggestions, coordinator=None):
        """빠른 답장을 창 하단에 추가"""
        if self._suggest_area_built or not self.panel:
            return
        self._suggest_area_built = True

        content = self.panel.contentView()
        w = int(self.panel.frame().size.width - 40)
        suggest_h = len(suggestions) * 60 + 28  # 라벨(18+10) + 버튼(28*6)

        # 1. 모든 기존 서브뷰의 autoresizing 비활성화
        subviews = list(content.subviews())
        masks = [(v, v.autoresizingMask()) for v in subviews]
        for v in subviews:
            v.setAutoresizingMask_(0)

        # 2. 창 확장
        frame = self.panel.frame()
        frame.size.height += suggest_h
        frame.origin.y -= suggest_h
        self.panel.setFrame_display_animate_(frame, True, False)

        # 3. 하단 버튼(y≤50) 제외, 나머지를 suggest_h만큼 위로 이동
        for v in subviews:
            f = v.frame()
            if f.origin.y > 50:
                f.origin.y += suggest_h
                v.setFrame_(f)

        # 4. autoresizing 복원 — 단, 번역 테이블(HeightSizable)은 하단 고정으로 변경
        for v, mask in masks:
            if mask & NSViewHeightSizable and f.origin.y > 50:
                # 번역 테이블: 높이 가변 유지하되, 하단 경계를 제안 영역 위로
                v.setAutoresizingMask_(mask)
            else:
                v.setAutoresizingMask_(mask)

        # 5. 최소 크기 업데이트 (제안 영역 높이 추가)
        cur_min = self.panel.minSize()
        self.panel.setMinSize_((cur_min.width, cur_min.height + suggest_h))

        # 6. 제안 라벨 (하단 버튼 바로 위, 하단 고정)
        lbl3 = NSTextField.labelWithString_("빠른 답장 (클릭하면 복사)")
        lbl3.setFont_(NSFont.systemFontOfSize_(11))
        lbl3.setTextColor_(FG_DIM)
        lbl3.setFrame_(((20, 56), (w, 18)))
        lbl3.setBackgroundColor_(NSColor.clearColor())
        lbl3.setAutoresizingMask_(NSViewWidthSizable | NSViewMaxYMargin)
        content.addSubview_(lbl3)

        # 7. 제안 버튼들 (하단 고정)
        y = 56
        for s in reversed(suggestions):
            y += 28
            btn = self._make_suggest_btn("JP: " + s["jp"], y, w, coordinator)
            btn.setAutoresizingMask_(NSViewWidthSizable | NSViewMaxYMargin)
            content.addSubview_(btn)
            y += 28
            btn = self._make_suggest_btn("KR: " + s["kr"], y, w, coordinator)
            btn.setAutoresizingMask_(NSViewWidthSizable | NSViewMaxYMargin)
            content.addSubview_(btn)

    def _make_suggest_btn(self, title, y, w, coordinator):
        btn = NSButton.alloc().initWithFrame_(((20, y), (w, 24)))
        btn.setTitle_(title)
        btn.setBezelStyle_(NSBezelStyleRounded)
        btn.setAlignment_(NSTextAlignmentLeft)
        btn.setFont_(NSFont.systemFontOfSize_(12))
        btn.setTarget_(coordinator)
        btn.setAction_(objc.selector(coordinator.onSuggestCopy_, signature=b"v@:@"))
        btn.setAutoresizingMask_(NSViewWidthSizable)
        return btn

    def _make_table_view(self, content, rect, is_html=False):
        """HTML 또는 TSV를 테이블로 렌더링 (NSAttributedString + NSTextView)"""
        from Foundation import NSData
        appearance = AppKit.NSApp.effectiveAppearance()
        is_dark = "Dark" in str(appearance.name())
        fg = "#e0e0e0" if is_dark else "#222"
        bg = "#2a2a2a" if is_dark else "#fff"
        border = "#555" if is_dark else "#ccc"

        if is_html and "<table" in content.lower():
            # AI가 반환한 HTML 테이블 — 스타일만 입혀서 렌더링
            import re
            styled_table = content
            # <table>에 스타일 추가 (width 미지정 → 내용에 맞게 자동 조절)
            styled_table = re.sub(
                r'<table[^>]*>',
                f'<table style="border-collapse:collapse; '
                f'font-family:-apple-system,sans-serif; font-size:12px; color:{fg};">',
                styled_table, count=1, flags=re.IGNORECASE
            )
            # <td>, <th>에 스타일 추가
            cell_style = (
                f'border:1px solid {border}; padding:6px 10px; '
                f'vertical-align:top; background:{bg}; white-space:pre-wrap;'
            )
            styled_table = re.sub(
                r'<(td|th)(\s[^>]*)?>',
                lambda m: f'<{m.group(1)}{m.group(2) or ""} style="{cell_style}">',
                styled_table, flags=re.IGNORECASE
            )
            table_html = styled_table
        else:
            # TSV → HTML 테이블 (폴백)
            rows = content.strip().split("\n")
            table_rows = []
            header_bg = "#333" if is_dark else "#f0f0f0"
            for i, row in enumerate(rows):
                cells = row.split("\t")
                cell_bg = header_bg if i == 0 else bg
                weight = "bold" if i == 0 else "normal"
                table_rows.append(
                    "<tr>" +
                    "".join(
                        f'<td style="border:1px solid {border}; padding:6px 10px; '
                        f'vertical-align:top; background:{cell_bg}; font-weight:{weight}; '
                        f'white-space:pre-wrap;">'
                        f'{html_mod.escape(c)}</td>' for c in cells
                    ) + "</tr>"
                )
            table_html = (
                f'<table style="border-collapse:collapse; '
                f'font-family:-apple-system,sans-serif; font-size:12px; color:{fg};">'
                f'{"".join(table_rows)}</table>'
            )

        html_str = (
            f'<html><head><meta charset="utf-8"></head>'
            f'<body style="margin:0;">{table_html}</body></html>'
        )
        data = NSData.dataWithBytes_length_(html_str.encode("utf-8"), len(html_str.encode("utf-8")))
        result = AppKit.NSAttributedString.alloc().initWithHTML_documentAttributes_(data, None)
        attr_str = result[0] if isinstance(result, tuple) else result

        scroll = NSScrollView.alloc().initWithFrame_(rect)
        scroll.setHasVerticalScroller_(True)
        scroll.setHasHorizontalScroller_(True)
        scroll.setBorderType_(0)

        view_w = rect[1][0]
        tv = NSTextView.alloc().initWithFrame_(((0, 0), (view_w, rect[1][1])))
        tv.textStorage().setAttributedString_(attr_str)
        tv.setEditable_(False)
        tv.setBackgroundColor_(SURFACE)
        tv.setTextContainerInset_((4, 4))
        # 내용이 뷰 너비보다 넓으면 가로 스크롤
        tv.setHorizontallyResizable_(True)
        tv.textContainer().setWidthTracksTextView_(False)
        tv.textContainer().setContainerSize_((max(view_w, 2000), 10000))
        scroll.setDocumentView_(tv)
        scroll.setBackgroundColor_(SURFACE)
        return scroll

    def _make_text_area(self, text, rect):
        scroll = NSScrollView.alloc().initWithFrame_(rect)
        scroll.setHasVerticalScroller_(True)
        scroll.setBorderType_(0)

        tv = NSTextView.alloc().initWithFrame_(((0, 0), (rect[1][0], rect[1][1])))
        tv.setString_(text)
        tv.setEditable_(False)
        tv.setFont_(NSFont.systemFontOfSize_(13))
        tv.setTextColor_(FG)
        tv.setBackgroundColor_(SURFACE)
        tv.setTextContainerInset_((8, 8))
        scroll.setDocumentView_(tv)
        scroll.setBackgroundColor_(SURFACE)
        return scroll

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
        self.panel.setTitle_("번역 결과")
        self.panel.setBackgroundColor_(BG)
        self.panel.setTitlebarAppearsTransparent_(True)
        self.panel.setMovableByWindowBackground_(True)

    def _close(self):
        if self.panel:
            self.panel.orderOut_(None)
            self.panel = None


# ─── Coordinator (NSObject 서브클래스 — objc 셀렉터 호출용) ───
class Coordinator(NSObject):

    def init(self):
        self = objc.super(Coordinator, self).init()
        if self is None:
            return None
        self._window = TranslatorWindow()
        self._status_bar = StatusBarItem()
        return self

    def triggerTranslation_(self, timer):
        log("단축키 감지 → 선택 텍스트 복사 중…")
        old_clip = get_clipboard()
        # old_clip이 튜플이면 텍스트 부분만 비교용으로 사용
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

    def setStatusTranslating_(self, _):
        self._status_bar.set_status("⏳ 번역 중…")

    # ─── 버튼 핸들러 ─────────────────────────────────────────
    def onCopyTranslation_(self, sender):
        log("번역 복사 클릭")
        translated = self._window._translated
        if self._window._is_table:
            # 번역 결과가 HTML이면 그대로, 아니면 TSV→HTML 변환
            translated_html = translated if "<table" in translated.lower() else _tsv_to_html_table(translated)
            # plain text는 HTML 태그 제거한 텍스트
            import re
            plain = re.sub(r'<[^>]+>', ' ', translated_html)
            plain = re.sub(r'\s+', ' ', plain).strip()
            set_clipboard_with_html(plain, translated_html)
            log("테이블 형식으로 복사 (HTML + 텍스트)")
        else:
            set_clipboard(translated)
        sender.setTitle_("✓ 복사됨")

    def onRequestSuggest_(self, sender):
        log("빠른 답장 버튼 클릭")
        sender.setTitle_("생성 중…")
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

    def onSuggestCopy_(self, sender):
        title = str(sender.title())
        # 이미 선택된 버튼을 다시 클릭하면 무시
        if title.startswith("✓ "):
            return
        # 다른 제안 버튼의 체크 해제
        content = self._window.panel.contentView()
        for v in content.subviews():
            if isinstance(v, NSButton) and str(v.title()).startswith("✓ "):
                v.setTitle_(str(v.title())[2:])  # "✓ " 제거
        # 선택한 버튼만 체크
        text = title.split(": ", 1)[-1] if ": " in title else title
        set_clipboard(text)
        sender.setTitle_("✓ " + title)
        log(f"답장 복사: {text}")

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

    def showSuggestions_(self, suggestions):
        log(f"showSuggestions_ 호출, {len(suggestions) if suggestions else 0}개")
        self._window._suggest_btn.setTitle_("빠른 답장")
        self._window._suggest_btn.setEnabled_(True)
        if suggestions:
            self._window._show_suggestions(suggestions, coordinator=self)
        self._status_bar.reset_status()

    def resetStatus_(self, _):
        self._status_bar.reset_status()

    def onSelectModel_(self, sender):
        selected = str(sender.title()).lower()
        if selected in MODELS:
            _current_model_idx[0] = MODELS.index(selected)
            log(f"모델 변경: {get_current_model()}")
        self._status_bar._update_model_check()

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
        self._status_bar.show(message, coordinator=self)

    def keepAlive_(self, timer):
        pass  # SIGINT가 메인 런루프에 전달되도록 주기적으로 깨움


# ─── Main ─────────────────────────────────────────────────────
def main():
    import Quartz

    app = NSApplication.sharedApplication()
    app.setActivationPolicy_(AppKit.NSApplicationActivationPolicyAccessory)

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
