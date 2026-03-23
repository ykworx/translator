# Transrator UI/UX 개선안

> 작성일: 2026-03-23 | 참여 팀원: 비주얼 디자이너, 인터랙션 디자이너, PM, 접근성 전문가

---

## 팀 논의 결과: 우선순위 합의

4명의 팀원이 독립 분석 후 크로스 리뷰한 결과, **공통적으로 지적된 상위 이슈** 중심으로 합의했습니다.

### 전원 합의 (4/4 팀원 동의) — 반드시 해결

| # | 개선안 | 근거 |
|---|--------|------|
| 1 | **첫 실행 온보딩 + 빈 상태 화면** | PM·인터랙션·접근성·비주얼 전원 지적. API 키 없으면 앱이 무용 |
| 2 | **스트리밍 번역 (메인 경로)** | PM·인터랙션 지적. 이미 `translateStream` 존재하나 메인에 미적용 |
| 3 | **에러 복구 (재시도 버튼)** | 인터랙션·PM 지적. 에러 시 복구 경로 전무 |
| 4 | **카드 pill 버튼 접근성** | 접근성·인터랙션 지적. 키보드/스크린리더 접근 불가 |

### 3/4 팀원 동의 — 높은 우선순위

| # | 개선안 | 근거 |
|---|--------|------|
| 5 | **툴바 계층 정리** | 비주얼·인터랙션·PM 동의. 5개 버튼 과밀 |
| 6 | **색상 대비 수정** | 접근성·비주얼 동의. WCAG AA 미달 다수 |
| 7 | **키보드 단축키 추가** | 인터랙션·접근성·PM 동의. Escape, ⌘K, ⌘⇧C |
| 8 | **단축키 번역 후 자동 복사** | 인터랙션·PM 동의. "선택→단축키→붙여넣기" 흐름 완성 |

### 2/4 팀원 동의 — 보통 우선순위

| # | 개선안 | 근거 |
|---|--------|------|
| 9 | **번역 카드 시각적 구분 강화** | 비주얼 제안. 번역 결과에 왼쪽 파란 보더 |
| 10 | **타이틀바 + 스페이싱 최적화** | 비주얼 제안. 620x520 공간 효율 |
| 11 | **번역 히스토리 영속화** | PM 제안. 앱 닫으면 히스토리 소실 |
| 12 | **ARIA 역할 + 스크린리더 지원** | 접근성 제안. `role="log"`, `aria-live` |

---

## 상세 개선안

### 1. 첫 실행 온보딩 + 빈 상태 화면

**문제**: API 키 없이 앱 실행 시 빈 화면. 사용법 안내 없음.

**해결**: 상태에 따른 빈 화면 분기

```
[API 키 미설정]                    [API 키 설정 완료]
┌─────────────────────┐           ┌─────────────────────┐
│        🔑           │           │      ⌘⌃T            │
│  API 키가 필요합니다  │           │ 텍스트를 선택하고     │
│ [____API키입력____]  │           │  ⌘+Ctrl+T           │
│      [저장]          │           │                     │
│  Google AI Studio →  │           │ 또는 아래에 직접 입력  │
└─────────────────────┘           │ ⌘⌃T 선택  ⌘⌃⇧T 캡처 │
                                  └─────────────────────┘
```

**구현 파일**: `ui.ts`, `main.ts`, `styles.css`
**공수**: 3-4시간

### 2. 스트리밍 번역 (메인 입력 경로)

**문제**: `handleSubmit()`이 비스트리밍 `translate()` 사용. 로딩 점 → 전체 결과 한 번에 표시.

**해결**: 이미 존재하는 `translateStream()`을 메인 경로에 적용

```
[현재]  로딩... ● ● ●  →  전체 결과 한 번에
[개선]  번역 결과가 | 한 글자씩 나타남 → 완성
```

**구현**:
- `main.ts`의 `handleSubmit()`에서 `translate()` → `translateStream()` 전환
- `ui.ts`에 `renderStreamingEntry()` 추가 (커서 애니메이션 포함)
- 스트리밍 완료 후 pill 버튼 포함된 최종 `renderEntry()`로 교체

**공수**: 2-3시간 (인프라 이미 존재)

### 3. 에러 복구 (재시도 버튼 + API 키 안내)

**문제**: 에러 카드에 복구 수단 없음. API 키 에러도 일반 에러와 동일하게 표시.

**해결**: 에러 유형 분기 + 액션 버튼

```
┌─────────────────────────────┐
│ [오류] API 키가 설정되지 않았습니다 │
│ ─────────────────────────── │
│         [설정 열기]           │
└─────────────────────────────┘

┌─────────────────────────────┐
│ [오류] 네트워크 연결 실패       │
│ ─────────────────────────── │
│         [다시 시도]           │
└─────────────────────────────┘
```

**구현**: `ui.ts`의 `renderEntry()`에 에러 분기 추가, `main.ts`에 `retry-translation` 커스텀 이벤트 리스너
**공수**: 2시간

### 4. 카드 pill 버튼 접근성

**문제**: `<span>` + `opacity:0` + hover-only → 키보드/스크린리더 접근 불가

**해결**:
1. `<span class="card-pill">` → `<button type="button" class="card-pill">` 전환
2. CSS: `.card:focus-within .card-pills` 추가
3. `aria-label` 추가 ("원문 복사", "번역 결과 복사")
4. `:focus-visible` 스타일 추가

```css
/* hover 외에 focus-within으로도 표시 */
.card:hover .card-pills,
.card:focus-within .card-pills { opacity: 1; pointer-events: auto; }

.card-pill:focus-visible {
  outline: 2px solid rgba(0,122,255,0.8);
  outline-offset: 2px;
}
```

**공수**: 1시간

### 5. 툴바 계층 정리

**문제**: 5개 버튼이 동일 비중으로 나열. 히스토리 없으면 답장/요약이 무의미.

**해결**:

```
[현재] 🎙 음성 입력 | 🖥 실시간 번역 | 💬 빠른 답장 | 📋 요약 | 🗑 초기화 | 🔄 자동 감지

[개선] 🎙 음성 | 🖥 자막 | 💬 답장 | 📋 요약 |       🗑 | 🔄 자동 감지
       ─── 입력 ───  ─── AI (상황적) ───    ─── 위험 ───
```

- 버튼 레이블 축약 (공간 절약)
- 구분선(`toolbar-divider`)으로 그룹 분리
- 히스토리 없으면 답장/요약/초기화 비활성화 (`disabled`)

**공수**: 1-2시간

### 6. 색상 대비 수정 (WCAG AA)

**문제**: `--fg-dim: #888` (라이트)/ `#999` (다크)가 WCAG AA 4.5:1 미달

**해결**:

```css
:root {
  --fg-dim: #636363;  /* 기존 #888 → 4.5:1 이상 */
}
@media (prefers-color-scheme: dark) {
  :root {
    --fg-dim: #b0b0b0;  /* 기존 #999 → 4.5:1 이상 */
  }
}

/* .card-time의 opacity: 0.5 제거 (대비 추가 저하 방지) */
.card-time { opacity: 1; }
```

**공수**: 30분

### 7. 키보드 단축키

| 단축키 | 동작 | 컨텍스트 |
|--------|------|----------|
| `Escape` | 입력 비우기 / 창 숨기기 | 입력 있으면 비우기, 없으면 숨기기 |
| `⌘K` | 채팅 초기화 | 채팅앱 컨벤션 (Slack 등) |
| `⌘⇧C` | 마지막 번역 결과 복사 | 빠른 복사 |
| `⌘,` | 설정 열기 | macOS 표준 |
| `⌘⇧V` | 붙여넣기 + 즉시 번역 | 파워유저 |

**공수**: 1-2시간

### 8. 단축키 번역 후 자동 복사

**문제**: 선택→⌘⌃T→번역 결과 확인→카드 hover→복사 클릭 (5단계)

**해결**: 단축키 번역 완료 시 결과 자동 클립보드 복사 + 토스트 알림

```
선택→⌘⌃T→번역 완료→자동 복사→다른 앱에서 ⌘V (3단계)
                    ↑
             "✓ 번역 결과가 클립보드에 복사됨" (토스트 1.8초)
```

설정에서 on/off 가능하게 (`autoCopyOnHotkey` 키)

**공수**: 1-2시간

### 9. 번역 카드 시각적 구분 강화

**현재**: 원문과 번역 카드가 거의 동일한 외형 (크기만 약간 다름)

**개선**: 번역 결과 카드에 파란색 왼쪽 보더 + 약간 큰 폰트

```css
.card.trans {
  border-left: 3px solid rgba(0,122,255,0.5);
  font-size: 15px;
  font-weight: 500;
}
.card.orig {
  font-size: 12.5px;
}
```

**공수**: 15분

### 10. 타이틀바 + 스페이싱 최적화

```css
/* 타이틀바 52px → 42px (10px 확보) */
#titlebar { height: 42px; }
#titlebar .title { font-size: 12.5px; }

/* 채팅 영역 좌우 패딩 32px → 20px (24px 확보) */
#chat { padding: 16px 20px; }

/* 엔트리 간격 최적화 */
.entry { padding-bottom: 14px; margin-bottom: 14px; }
.section { margin-bottom: 10px; }
```

**공수**: 15분

### 11. 번역 히스토리 영속화

**문제**: 앱 종료/창 닫기 시 `chatHistory` 소실 (in-memory)

**해결**: Tauri Store 플러그인으로 자동 저장/복원

```typescript
// addEntry() 후 자동 저장
async function persistHistory(): Promise<void> {
  const slim = chatHistory.map(({ imageBase64, ...rest }) => rest); // 이미지 제외
  await setSetting("chatHistory", slim);
}

// 앱 시작 시 복원
async function restoreHistory(): Promise<void> {
  const saved = await getSetting("chatHistory", []);
  for (const entry of saved) {
    chatHistory.push(entry);
    chat.appendChild(renderEntry(entry));
  }
}
```

**공수**: 2-3시간

### 12. ARIA 역할 + 스크린리더 지원

```html
<!-- 채팅 영역 -->
<div id="chat" role="log" aria-label="번역 기록" aria-live="polite"></div>

<!-- 입력 필드 -->
<label for="input-field" class="sr-only">번역할 내용 입력</label>
<textarea id="input-field" aria-label="번역할 내용 입력" ...></textarea>

<!-- 언어 선택 -->
<label for="lang-select" class="sr-only">번역 대상 언어 선택</label>
<select id="lang-select" aria-label="번역 대상 언어 선택">

<!-- 로딩 상태 -->
<div class="card trans" role="status" aria-label="번역 중">
  <span class="sr-only">번역 중…</span>
</div>

<!-- 에러 카드 -->
<div class="card trans error" role="alert" aria-label="번역 오류">

<!-- reduced motion 지원 -->
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

**공수**: 1-2시간

---

## 구현 로드맵

### Sprint 1: 핵심 UX (1주)

| 순서 | 작업 | 공수 | 효과 |
|:----:|------|:----:|:----:|
| 1 | 빈 상태 + 온보딩 (#1) | 4h | 첫 사용자 전환율 |
| 2 | 스트리밍 번역 (#2) | 3h | 체감 속도 대폭 개선 |
| 3 | 에러 재시도 (#3) | 2h | 에러 복구 경로 |
| 4 | pill 버튼 접근성 (#4) | 1h | 키보드 사용자 지원 |
| 5 | 색상 대비 (#6) | 0.5h | 가독성 |

### Sprint 2: 생산성 + 폴리시 (1주)

| 순서 | 작업 | 공수 | 효과 |
|:----:|------|:----:|:----:|
| 6 | 툴바 정리 (#5) | 2h | 시각적 정리 |
| 7 | 키보드 단축키 (#7) | 2h | 파워유저 생산성 |
| 8 | 자동 복사 + 토스트 (#8) | 2h | 핵심 플로우 단축 |
| 9 | 카드 구분 + 스페이싱 (#9, #10) | 0.5h | 비주얼 폴리시 |
| 10 | ARIA + 접근성 (#12) | 2h | 스크린리더 지원 |

### Sprint 3: 데이터 영속화 (선택)

| 순서 | 작업 | 공수 | 효과 |
|:----:|------|:----:|:----:|
| 11 | 히스토리 영속화 (#11) | 3h | 세션 간 데이터 유지 |
| 12 | 히스토리 검색 | 3h | 과거 번역 재활용 |

---

## PM의 전략적 권고

> **"기능을 더 추가하기 전에, 핵심 번역 루프를 완벽하게 만들어라."**

현재 Transrator의 **진짜 강점**:
1. 테이블 구조 인식 번역 (경쟁사 없음)
2. 이미지 OCR + 번역 핫키 (유일무이)
3. 앱 오디오 캡처 → Whisper → 실시간 번역 파이프라인 (기술적 해자)

이 3가지를 더 다듬는 것이 발음 가이드나 요약 같은 부가 기능보다 중요합니다.

**KR-JP 니치를 소유하세요.** 30개 언어를 지원하는 DeepL과 경쟁하지 말고, KR-JP 사용자에게 "이것만은 Transrator가 최고"라는 인식을 심어야 합니다.

---

*이 개선안은 비주얼 디자이너, 인터랙션 디자이너, PM, 접근성 전문가 4인의 독립 분석과 크로스 리뷰를 통해 합의된 결과입니다.*
