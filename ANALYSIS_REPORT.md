# Transrator 종합 분석 리포트

> 분석일: 2026-03-23 | 분석 버전: v0.2.0 | 분석팀: 5명 (프론트엔드, 백엔드, 아키텍처, 보안/성능, UX)

---

## 목차

1. [프로젝트 개요](#1-프로젝트-개요)
2. [아키텍처 건강도 요약](#2-아키텍처-건강도-요약)
3. [Critical 이슈](#3-critical-이슈)
4. [프론트엔드 분석](#4-프론트엔드-분석)
5. [백엔드(Rust) 분석](#5-백엔드rust-분석)
6. [보안 감사](#6-보안-감사)
7. [성능 분석](#7-성능-분석)
8. [UX/UI 분석](#8-uxui-분석)
9. [개선 로드맵](#9-개선-로드맵)
10. [혁신 아이디어](#10-혁신-아이디어)

---

## 1. 프로젝트 개요

**Transrator**는 macOS용 팝업 번역기로, Tauri 2 + vanilla TypeScript + Rust로 구축된 데스크톱 앱입니다.

- **핵심 기능**: 글로벌 단축키(⌘+Ctrl+T)로 선택 텍스트/테이블/이미지 번역
- **번역 엔진**: Google Gemini API (스트리밍 지원)
- **추가 기능**: 음성 입력(Apple Speech), 실시간 자막(Whisper + CoreML), 앱 자막 캡처
- **기술 스택**: Tauri 2, TypeScript(Vanilla), Rust, C FFI(Whisper.cpp, Apple Speech)

```
Frontend (16 TS files)  ←→  Tauri IPC  ←→  Backend (9 Rust files)
      ↓                                           ↓
  Gemini API (직접 호출)              C FFI (Whisper, Speech, CoreML)
```

---

## 2. 아키텍처 건강도 요약

| 항목 | 점수 | 상태 | 핵심 이슈 |
|------|:----:|:----:|-----------|
| **관심사 분리** | 7/10 | 양호 | 프론트엔드 모놀리식 구조 개선 필요 |
| **확장성** | 5/10 | 보통 | 폴링 방식, 요청 배치 없음, 캐싱 없음 |
| **유지보수성** | 6/10 | 보통 | 테스트 없음, 에러 처리 분산 |
| **타입 안전성** | 9/10 | 우수 | TS + Rust 완전 커버리지 |
| **크로스 플랫폼** | 3/10 | 미흡 | macOS 전용, 확장 어려움 |
| **보안** | 4/10 | 위험 | API 키 노출, CSP 비활성화 |
| **성능** | 7/10 | 양호 | 시작 빠르지만 폴링 비효율 |
| **코드 품질** | 6/10 | 보통 | 기술 부채 존재, 린팅 없음 |
| **테스트** | 0/10 | 위험 | 테스트 스위트 전무 |
| **전체** | **5.2/10** | | 기능적이나 안정화 투자 필요 |

---

## 3. Critical 이슈

### 3.1 API 키 Git 히스토리 노출 (CVSS 9.8)

`.env` 파일에 Gemini API 키가 평문으로 저장되어 있고, `.gitignore`에 제외되지 않아 **Git 히스토리에 API 키가 노출**되어 있습니다.

```
# .env (커밋됨)
GEMINI_API_KEY=AIzaSyCm4fbo...
```

**즉시 조치 필요:**
1. Google Cloud Console에서 API 키 즉시 교체
2. Git 히스토리에서 `.env` 제거 (`git filter-branch`)
3. `.gitignore`에 `.env` 추가

### 3.2 API 키 URL 쿼리 파라미터 노출

`geminiClient.ts:18` — API 키가 URL에 포함되어 네트워크 로그, DevTools, 브라우저 히스토리에 노출됩니다.

```typescript
// 현재 (위험)
`https://...googleapis.com/.../generateContent?key=${apiKey}`

// 개선안: 백엔드 프록시로 이동
#[tauri::command]
pub async fn translate(text: String) -> Result<String, String> {
    let api_key = std::env::var("GEMINI_API_KEY")?;
    // Rust 백엔드에서 API 호출
}
```

### 3.3 CSP(Content Security Policy) 비활성화 (CVSS 9.1)

`tauri.conf.json:41` — `"csp": null`로 설정되어 XSS 공격에 완전히 노출됩니다.

```json
// 개선안
"security": {
  "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src https://generativelanguage.googleapis.com; frame-ancestors 'none';"
}
```

---

## 4. 프론트엔드 분석

### 4.1 상태 관리 문제

**전역 변수 남발** — 13개 이상의 전역 변수가 `appCaptions.ts`에 산재:

```typescript
// appCaptions.ts — 상태 스파게티
let isAppCaptionsRunning = false;
let overlayCaptions: OverlayCaption[] = [];
let translatedCaptionSegmentIds = new Set<string>();
let pendingCaptionSegmentIds = new Set<string>();
let captionRetryStates = new Map<string, CaptionRetryState>();
let pendingTranslationBuffer = "";
// ... 7개 더
```

**개선안:** 상태 머신 클래스로 통합

```typescript
type AppCaptionState = "idle" | "starting" | "running" | "stopping" | "error";

class AppCaptionManager {
  private state: AppCaptionState = "idle";
  private captions: OverlayCaption[] = [];
  private translatedIds = new Set<string>();
  // ... 응집도 높은 구조
}
```

### 4.2 chatHistory 크기 off-by-one 버그

`ui.ts:239-242` — push 후 검사하므로 MAX_HISTORY+1개까지 존재 가능, DOM과 배열 비동기 가능:

```typescript
// 현재 (버그)
chatHistory.push(entry);
if (chatHistory.length > MAX_HISTORY) {
    chatHistory.shift();
    chat.firstElementChild?.remove(); // DOM 없으면 상태 불일치
}
```

### 4.3 에러 시 입력 데이터 소실

`main.ts:39-55` — 요청 전에 입력을 비워서 실패 시 사용자 텍스트 유실:

```typescript
// 개선안: 성공 시에만 비우기
try {
    const result = await translate(...);
    inputField.value = ""; // 성공 후 비우기
    addEntry({ original: text, translated: result });
} catch (e) {
    inputField.value = text; // 실패 시 복원
}
```

### 4.4 무한 폴링 루프 위험

`appCaptions.ts:320-325` — 타이핑 애니메이션 대기 `setInterval`에 타임아웃 없음:

```typescript
// 개선안: 타임아웃 가드 추가
let waitTime = 0;
const waitForTyping = setInterval(() => {
    waitTime += 50;
    if (waitTime > 10000) { clearInterval(waitForTyping); finishUp(); return; }
    // ...
}, 50);
```

### 4.5 DOM 성능 문제

`appCaptions.ts:128-211` — 매 캡션 업데이트마다 `querySelectorAll` 호출(O(n)):

- 가상 스크롤링 미적용 (100+ 캡션 전체 렌더링)
- `setInterval` 기반 타이핑 애니메이션 (100개 = 3333 콜백/초)
- `typingQueues` Map 무한 증가 (삭제된 캡션 미정리)

**개선안:** `requestAnimationFrame` + WeakMap 엘리먼트 캐싱 + 가시 영역만 렌더링

### 4.6 기타 프론트엔드 이슈

| 이슈 | 파일 | 심각도 | 설명 |
|------|------|:------:|------|
| 네트워크/API 에러 구분 없음 | geminiClient.ts | HIGH | 재시도 로직 없음 |
| 이미지 크기 미검증 | clipboardTranslate.ts | MEDIUM | 4K 스크린샷 → 25MB base64 |
| 이벤트 리스너 메모리 누수 | ui.ts:129-171 | MEDIUM | 삭제된 엔트리의 클로저 참조 유지 |
| 모듈 초기화 패턴 불일치 | speechInput.ts 등 | LOW | 2회 호출 시 리스너 중복 |

---

## 5. 백엔드(Rust) 분석

### 5.1 Unsafe FFI 안전성 문제

**C 문자열 메모리 누수 위험** — `speech.rs`, `model_manager.rs`:

```rust
// 현재: ?로 인해 speech_free_string 호출 건너뛸 수 있음
let raw = unsafe { CStr::from_ptr(pointer) }
    .to_str()
    .map(str::to_owned)?; // ← 여기서 에러 시 free 안됨
unsafe { speech_free_string(pointer) };

// 개선안: RAII 패턴
struct ScopedCPtr(*mut c_char);
impl Drop for ScopedCPtr {
    fn drop(&mut self) {
        if !self.0.is_null() { unsafe { speech_free_string(self.0) }; }
    }
}
```

### 5.2 Zip 경로 탐색 취약점 (보안)

`model_manager.rs:146-151` — `archive.extract(&dir)`가 `../` 경로 검증 없이 실행:

```rust
// 현재 (취약)
let mut archive = zip::ZipArchive::new(file)?;
archive.extract(&dir)?; // 악성 zip이 시스템 파일 덮어쓸 수 있음

// 개선안: 경로 검증
for i in 0..archive.len() {
    let file = archive.by_index(i)?;
    if file.name().contains("..") { return Err("Invalid zip entry".into()); }
}
```

### 5.3 문자열 슬라이싱 유니코드 문제

`clipboard.rs:30-35` — 바이트 기반 슬라이싱이 유니코드에서 패닉 가능:

```rust
// 현재 (위험)
let table = &cleaned[start..end_pos + 8]; // UTF-8 경계 위반 가능

// 추가 문제: to_lowercase() 2회 호출 (비효율)
if let Some(start) = cleaned.to_lowercase().find("<table") {
    if let Some(end_pos) = cleaned.to_lowercase().find("</table>") {
```

### 5.4 Mutex 포이즈닝 미처리

`lib.rs:168` — 다른 스레드 패닉 시 `.unwrap()`으로 앱 크래시:

```rust
let mut current = sc_state.lock().unwrap(); // 패닉 전파

// 개선안
let mut current = sc_state.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
```

### 5.5 모델 로딩이 앱 시작을 블로킹

`lib.rs` setup — `auto_load_model()`이 동기적으로 실행되어 1.6GB+ 모델 로딩 시 앱 시작 지연:

```rust
// 개선안: 백그라운드 스레드로 이동
std::thread::spawn(move || {
    model_manager::auto_load_model(app_handle);
});
```

### 5.6 기타 백엔드 이슈

| 이슈 | 파일 | 심각도 | 설명 |
|------|------|:------:|------|
| 다운로드 모델 체크섬 검증 없음 | model_manager.rs | HIGH | DNS 하이재킹 시 악성 모델 |
| NSWindow 이중 retain | window.rs:52-59 | HIGH | 메모리 누수 |
| screencapture 타임아웃 없음 | shortcut.rs:137 | MEDIUM | 취소 시 무한 블로킹 |
| OnceLock 중복 초기화 무시 | caption_capture.rs:7 | MEDIUM | stale handle 가능 |
| 에러 메시지 한/영 혼재 | 전체 | LOW | 일관성 부재 |

---

## 6. 보안 감사

### 보안 취약점 요약

| 카테고리 | 이슈 | 심각도 | CVSS |
|----------|------|:------:|:----:|
| API 키 | Git 히스토리 + URL 노출 | **CRITICAL** | 9.8 |
| CSP | 완전 비활성화 | **CRITICAL** | 9.1 |
| 설정 암호화 | API 키 평문 저장 | **HIGH** | 7.3 |
| 프라이버시 | 클립보드 데이터 무조건 클라우드 전송 | **HIGH** | 7.5 |
| 입력 검증 | 프롬프트 인젝션 미방어 | **HIGH** | 7.2 |
| 네트워크 | 인증서 피닝 없음 | **HIGH** | 7.1 |
| XSS/DOM | innerHTML 일관성 없는 이스케이프 | **MEDIUM** | 5.3 |
| 권한 | 클립보드/스토어 과도한 권한 | **MEDIUM** | 4.9 |
| 의존성 | 보안 라이브러리 미사용 | **MEDIUM** | 4.1 |

### 핵심 보안 권고

1. **API 호출을 Rust 백엔드로 이동** — 프론트엔드에서 직접 API 호출 제거
2. **프라이버시 경고 다이얼로그 추가** — 클립보드 데이터 전송 전 사용자 동의
3. **프롬프트 인젝션 방어**:
   ```typescript
   function escapePromptText(text: string): string {
       return text.replace(/\[(?:System|Instruction):/gi, "[BLOCKED:");
   }
   ```
4. **설정 파일 암호화** — Tauri Secure Storage 또는 macOS Keychain 활용

---

## 7. 성능 분석

### 7.1 시작 성능

| 단계 | 예상 시간 | 병목 |
|------|:---------:|------|
| Tauri 윈도우 초기화 | ~300ms | - |
| 프론트엔드 로딩 | ~200ms | - |
| Whisper 모델 로딩 | ~2-5s | **메인 스레드 블로킹** |
| 전체 | ~3-5s | 모델 로딩 |

**개선안:** 모델 지연 로딩 (사용 시점에 로드)

### 7.2 번역 지연

| 시나리오 | 현재 | 최적화 후 |
|----------|:----:|:---------:|
| 텍스트 번역 | ~1-2s | ~0.8s (캐싱) |
| 테이블 번역 | ~3-5s | ~2s (배치 처리) |
| 이미지 번역 | ~5-10s | ~3s (리사이즈+JPEG) |

### 7.3 메모리 사용

- **기본 상태**: ~50MB (양호)
- **모델 로드 시**: ~500MB+ (Whisper 1.6GB)
- **장시간 자막**: 메모리 누수 위험 (typingQueues, 이벤트 리스너 미정리)

### 7.4 핵심 성능 개선 포인트

1. **폴링 → 이벤트 드리븐**: 음성 인식 350ms 폴링 → 콜백 (CPU 70% 절감)
2. **이미지 최적화**: 4K 이미지 리사이즈 + JPEG 압축 후 전송
3. **번역 캐싱**: 동일 텍스트 재번역 방지
4. **가상 스크롤**: 100+ 캡션 시 DOM 노드 최소화

---

## 8. UX/UI 분석

### 8.1 장점

- 깔끔한 3단계 플로우: 단축키 → 클립보드 → 즉시 번역
- 우수한 글래스모피즘 디자인 + 다크/라이트 모드
- 스트리밍 타이핑 효과
- 스마트 콘텐츠 감지 (HTML 테이블 → 텍스트 → 이미지)

### 8.2 주요 개선 필요 영역

| 영역 | 현재 상태 | 개선 방향 |
|------|----------|----------|
| **온보딩** | 없음 — 첫 사용자 혼란 | 3단계 가이드 (API 키 → 단축키 → 시작) |
| **에러 표시** | 채팅에 텍스트만 | 토스트 알림 + 복구 가이드 + 재시도 버튼 |
| **접근성** | 키보드 네비게이션 미지원 | Alt+M/C/R/S 단축키, ARIA 라벨 |
| **설정** | 옵션 많고 설명 부족 | 툴팁, 검색, 섹션 설명 추가 |
| **다국어** | 한국어 전용 하드코딩 | i18n 시스템 (ko/en/ja) |
| **기능 발견** | card-pills 호버 시에만 표시 | 터치 기기에서 항상 표시 |

### 8.3 경쟁사 대비 부족한 기능

| 기능 | DeepL | Google | Transrator |
|------|:-----:|:------:|:----------:|
| 문서 번역 | O | O | **X** |
| 오프라인 모드 | O | O | **X** |
| 발음 재생 | O | O | **부분** |
| 번역 히스토리 내보내기 | O | O | **X** |
| 번역 즐겨찾기 | O | O | **X** |
| 용어집 | O | X | **X** |
| 번역 비교 | X | X | **X** |

---

## 9. 개선 로드맵

### Phase 1: 긴급 안정화 (1-2주)

| 우선순위 | 작업 | 예상 공수 | 담당 |
|:--------:|------|:---------:|:----:|
| P0 | API 키 교체 + Git 히스토리 정리 | 1h | 보안 |
| P0 | CSP 활성화 | 1h | 보안 |
| P0 | `.gitignore`에 `.env` 추가 | 5m | 보안 |
| P1 | API 호출을 Rust 백엔드로 이동 | 2d | 백엔드 |
| P1 | Zip 경로 탐색 취약점 수정 | 2h | 백엔드 |
| P1 | chatHistory off-by-one 버그 수정 | 1h | 프론트 |
| P1 | 무한 폴링 루프 타임아웃 추가 | 2h | 프론트 |

### Phase 2: 품질 강화 (3-4주)

| 우선순위 | 작업 | 예상 공수 | 담당 |
|:--------:|------|:---------:|:----:|
| P2 | 테스트 스위트 구축 (Jest + cargo test, 40% 커버리지) | 5d | 전체 |
| P2 | 에러 처리 통합 (토스트 + 재시도 로직) | 2d | 프론트 |
| P2 | Mutex 포이즈닝 + C FFI RAII 래퍼 | 2d | 백엔드 |
| P2 | 모델 로딩 비동기화 (시작 블로킹 해소) | 1d | 백엔드 |
| P2 | 이미지 최적화 (리사이즈 + 압축) | 1d | 백엔드 |
| P3 | 온보딩 플로우 구현 | 2d | UX |
| P3 | 키보드 접근성 + ARIA 라벨 | 1d | UX |

### Phase 3: 기능 확장 (5-8주)

| 우선순위 | 작업 | 예상 공수 | 담당 |
|:--------:|------|:---------:|:----:|
| P3 | 상태 관리 리팩토링 (클래스 기반) | 3d | 아키텍처 |
| P3 | 폴링 → 이벤트 드리븐 전환 | 2d | 백엔드 |
| P3 | 번역 캐싱 + 요청 배치 처리 | 2d | 프론트 |
| P3 | CI/CD 파이프라인 (GitHub Actions) | 1d | 인프라 |
| P4 | 크로스 플랫폼 추상 레이어 (trait 기반) | 4d | 아키텍처 |
| P4 | i18n 시스템 (ko/en/ja) | 2d | UX |
| P4 | 설정 암호화 | 1d | 보안 |

---

## 10. 혁신 아이디어

### 10.1 번역 메모리 (Translation Memory)

사용자의 과거 번역을 저장하고 유사 문장 자동 제안:

```typescript
class TranslationMemory {
  async getSimilarTranslations(text: string): Promise<string[]> {
    // 80%+ 유사도 매칭 → 즉시 제안
    // API 호출 없이 캐시에서 결과 반환
  }
}
```

**가치:** API 비용 절감 + 일관된 번역 + 즉시 결과

### 10.2 A/B 번역 비교

Gemini 모델 간 비교 (2.0-flash vs 2.5-pro):

```
┌─────────────────────┬─────────────────────┐
│  gemini-2.0-flash   │   gemini-2.5-pro    │
│ "안녕하세요"          │ "안녕하세요"          │
│ 0.3초 | 무료         │ 0.8초 | 유료         │
└─────────────────────┴─────────────────────┘
```

**가치:** 번역 품질 비교 → 최적 모델 선택

### 10.3 개인 용어집 (Personal Glossary)

번역 과정에서 자동 학습하는 용어 데이터베이스:

```typescript
// "日" → 문맥에 따라 "일/날/해" 자동 선택
class TerminologyDB {
  async learnTerm(source: string, target: string, context: string) { ... }
  async buildPromptWithTerms(text: string): string {
    // 관련 용어를 프롬프트에 자동 포함
    return `용어: "sprint" = "스프린트" (프로젝트 관리)\n\n번역: ${text}`;
  }
}
```

**가치:** 도메인 특화 번역 (의료/법률/IT) 품질 향상

### 10.4 번역 워크플로우 템플릿

상황별 맞춤 번역 프롬프트:

| 템플릿 | 용도 | 프롬프트 특성 |
|--------|------|--------------|
| 이메일 | 비즈니스 이메일 | 격식체, 존칭 |
| 일상 대화 | 채팅/메신저 | 구어체, 축약 |
| 기술 문서 | API 문서 등 | 기술 용어 보존 |
| 학술 논문 | 논문/리포트 | 학술적 표현 |

**가치:** 컨텍스트별 최적 번역 품질

### 10.5 발음 재생 (TTS)

번역 결과에 음성 재생 버튼 추가:

```typescript
async function playPronunciation(text: string, lang: string) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang === '한국어' ? 'ko-KR' : 'ja-JP';
  utterance.rate = 0.8; // 학습용 느린 속도
  speechSynthesis.speak(utterance);
}
```

**가치:** 어학 학습 도구로 확장 가능

### 10.6 번역 품질 신뢰도 점수

AI 번역의 확신도를 시각적으로 표시:

```
"この件について" → "이 건에 대해서" [신뢰도: 95%] ✓
"やばい"        → "대박"           [신뢰도: 62%] ⚠ 다른 번역 보기
```

**가치:** 사용자가 번역 품질 판단 가능 + 대안 제시

### 10.7 실시간 협업 용어집

팀 단위 용어집 클라우드 동기화:

```
[팀 용어집]
"sprint" → "스프린트" (not "전력질주")
"backlog" → "백로그" (not "잔업")
"deploy" → "배포" (not "전개")
```

**가치:** 팀 번역 일관성 확보

### 10.8 오프라인 번역 모드

Whisper + 로컬 LLM으로 네트워크 없이 번역:

- 이미 Whisper.cpp 탑재 → 음성→텍스트 가능
- llama.cpp 추가로 텍스트→텍스트 번역 가능
- 민감한 데이터 외부 전송 없이 처리

**가치:** 보안 환경 + 오프라인 환경 지원

---

## 부록: 파일별 이슈 매핑

| 파일 | Critical | High | Medium | Low |
|------|:--------:|:----:|:------:|:---:|
| `.env` | 1 | - | - | - |
| `geminiClient.ts` | 1 | 1 | 1 | - |
| `tauri.conf.json` | 1 | - | - | - |
| `appCaptions.ts` | - | 2 | 3 | 1 |
| `lib.rs` | - | 1 | 2 | - |
| `model_manager.rs` | - | 2 | 1 | 1 |
| `clipboard.rs` | - | 1 | 1 | 1 |
| `clipboardTranslate.ts` | - | 1 | 1 | - |
| `ui.ts` | - | 1 | 2 | - |
| `main.ts` | - | 1 | 1 | - |
| `speech.rs` | - | 1 | - | - |
| `window.rs` | - | 1 | - | - |
| `settings.ts` | - | - | 1 | - |
| **합계** | **3** | **12** | **13** | **3** |

---

*이 리포트는 프론트엔드, 백엔드, 아키텍처, 보안/성능, UX 5개 전문 팀의 분석을 종합한 결과입니다.*
