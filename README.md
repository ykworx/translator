# Transrator

Tauri 2와 vanilla TypeScript로 만든 macOS 중심의 팝업 번역기입니다. 선택한 텍스트·표·클립보드 이미지와 캡처 영역을 번역하며, 트레이에서 실행됩니다.

## 구현된 기능

- 텍스트·표·이미지 번역 및 텍스트 번역 결과 스트리밍
- Gemini API, OpenAI API, Ollama 백엔드 선택
- 자동 언어 전환, 답장 추천, 요약, 한글 발음 표시
- 마이크 음성 입력: Whisper 인식 결과를 입력창에 넣은 뒤 Enter로 번역
- 다른 앱의 오디오를 번역하는 실시간 자막: 설정의 실험적 자막 옵션으로 표시
- 캔버스 및 전체 화면 오버레이의 필기 인식

음성 입력과 앱 자막은 macOS 전용입니다. 이미지 번역·필기 인식에는 이미지 입력을 지원하는 모델이 필요합니다.

## 개발 환경과 설치

macOS 네이티브 빌드에는 Node.js/npm, Rust 도구 체인, Xcode Command Line Tools의 Swift·macOS SDK, CMake가 필요합니다. Whisper와 RNNoise는 Git 서브모듈로 포함되어 있습니다.

```bash
git clone --recurse-submodules https://github.com/ykworx/translator.git
cd translator
npm ci
```

이미 복제한 저장소에서는 서브모듈을 초기화합니다.

```bash
git submodule update --init --recursive
```

## 실행과 빌드

아래 명령은 저장소 루트에서 실행합니다.

```bash
# Vite와 Tauri 앱을 함께 실행
npm run tauri -- dev

# 프런트엔드만 실행 (포트 1420)
npm run dev

# 프런트엔드 배포 파일 생성
npm run build

# 네이티브 앱과 설치 패키지 생성
npm run tauri -- build
```

프런트엔드만 실행하면 Tauri IPC가 필요한 기능은 사용할 수 없습니다. macOS 배포 빌드는 `src-tauri/tauri.conf.json`에 지정된 `Transrator Developer` 서명 인증서를 사용하므로, 빌드 환경의 인증서 설정과 일치해야 합니다.

## 사용과 설정

트레이 메뉴의 **설정…**에서 백엔드, API 키, 언어 및 단축키를 설정합니다.

| 백엔드 | 필요한 설정 | 요청 경로 |
| --- | --- | --- |
| Gemini | Gemini API 키와 모델 | 프런트엔드에서 Gemini API 호출 |
| OpenAI | OpenAI API 키와 모델 | Tauri IPC를 통해 Rust에서 OpenAI API 호출 |
| Ollama | 실행 중인 서버의 URL과 설치한 모델 | 프런트엔드에서 Ollama 서버 호출 |

macOS 기본 단축키는 다음과 같습니다.

- `Cmd+Ctrl+T`: 선택한 내용을 복사한 뒤 번역
- `Cmd+Ctrl+Shift+T`: 영역 캡처 후 이미지 번역
- 입력창에서 `Enter`: 번역, `Shift+Enter`: 줄바꿈
- `Cmd+K`: 대화 지우기
- `Cmd+Shift+C`: 마지막 번역 복사

선택 영역 복사에는 macOS 손쉬운 사용 권한이, 영역 캡처·앱 자막에는 화면 기록 권한이, 음성 입력에는 마이크 권한이 필요합니다. 음성 기능은 설정에서 Whisper 모델을 다운로드한 뒤 사용합니다.

현재 음성 시작 흐름에는 모델이 메모리에 로드되지 않은 상태에서 권한 확인이 먼저 실패하는 제한이 있습니다. 모델 다운로드 직후와 달리, 앱 재실행 또는 자동 언로드 후에는 시작이 막힐 수 있습니다.

설정과 API 키는 Tauri Store의 앱 데이터 디렉토리 내 `settings.json`에 저장됩니다. 현재 Keychain 저장은 구현되어 있지 않습니다.

## 검증

```bash
# TypeScript 정적 검사 (출력 파일을 만들지 않음)
npm run typecheck

# 프런트엔드 단위 테스트 / 변경 감지 모드
npm test
npm run test:watch

# Rust 단위 테스트 (네이티브 빌드 도구와 서브모듈 필요)
cargo test --manifest-path src-tauri/Cargo.toml --lib

# 프런트엔드 프로덕션 빌드
npm run build
```

프런트엔드 테스트는 API 응답 처리, 백엔드 선택, 설정 마이그레이션 등을 모의 환경에서 검증합니다. Rust 단위 테스트는 OpenAI 응답·스트림 파싱과 재시도 헬퍼를 검증합니다. 실제 마이크·화면 캡처·전역 단축키의 동작은 별도 확인이 필요합니다. 일본어 음성 인식 데이터와 WER/CER·지연 시간 벤치마크는 [tests/README.md](tests/README.md)를 참고하세요.

## 주요 구조

```text
src/
  main.ts                 앱 초기화, 입력과 키보드 이벤트
  api.ts / prompts.ts     번역·요약·필기 인식 API와 프롬프트
  llmBackend.ts           백엔드 선택 및 공통 인터페이스
  *Client.ts              Gemini·OpenAI·Ollama 클라이언트
  clipboardTranslate.ts   클립보드 번역 흐름
  ui.ts / styles.css      대화 렌더링과 테마
  settings.ts / store.ts  설정 화면과 저장소 접근
  speechInput.ts          마이크 음성 입력
  appCaptions.ts          앱 오디오 자막 번역
  handwriting*.ts         필기 인식 패널·오버레이
src-tauri/
  src/                    Tauri 명령, 단축키, 창, 클립보드, 모델 관리
  swift/                  음성 캡처, Whisper·CoreML VAD 브리지
  vendor/                 Whisper·RNNoise 및 VAD 리소스
tests/                    단위 테스트와 음성 인식 벤치마크
```
