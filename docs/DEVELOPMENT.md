# 개발 안내

Transrator는 Tauri 2, vanilla TypeScript와 macOS Swift 브리지로 구성됩니다. 이 문서는 저장소를 복제해 개발·검증하는 사람을 위한 안내입니다. 앱 사용은 [README](../README.md), 기여 절차는 [CONTRIBUTING](../CONTRIBUTING.md), 배포는 [릴리즈 절차](RELEASING.md)를 참고하세요.

## 준비할 도구

macOS 네이티브 개발에는 다음 도구가 필요합니다.

| 도구 | 용도 |
| --- | --- |
| Node.js 22.12 이상인 22.x와 npm | Vite 요구 사항을 충족하는 CI와 같은 계열의 실행·검증 환경 |
| Rust stable과 Cargo | Tauri와 Rust 명령 빌드 |
| Xcode 또는 Xcode Command Line Tools | Swift, clang, macOS SDK와 `xcrun` |
| CMake | Whisper와 ggml 네이티브 빌드 |
| Python 3.11 이상 | 네이티브 검사 보조 스크립트와 릴리즈 버전 검사 |
| Git | 저장소와 Whisper·RNNoise 서브모듈 관리 |

macOS 도구 설치 방법은 [Tauri의 사전 요구 사항](https://v2.tauri.app/start/prerequisites/#macos)을 참고하세요. CLI 도구와 SDK를 찾을 수 있는지는 다음 명령으로 확인할 수 있습니다.

```bash
node --version
npm --version
cargo --version
xcrun swift --version
xcrun --sdk macosx --show-sdk-path
cmake --version
python3 --version
```

`python3`가 3.11보다 오래된 버전이면 설치한 최신 Python 실행 파일을 사용하세요. 기본 프런트엔드 검사에는 Rust·Swift나 모델 파일이 필요하지 않습니다. 아래 네이티브 안내는 macOS 기준이며, 음성 캡처는 macOS 전용입니다. 현재 배포 workflow는 Apple Silicon을 대상으로 합니다.

## 저장소와 의존성 준비

아래 명령은 저장소 루트에서 실행합니다. 포크에서 작업한다면 clone URL을 자신의 포크 주소로 바꿉니다.

```bash
git clone --recurse-submodules https://github.com/ykworx/translator.git
cd translator
npm ci
```

이미 복제한 저장소라면 네이티브 의존성을 초기화합니다.

```bash
git submodule update --init --recursive
```

`npm ci`는 `package-lock.json`을 사용합니다. Whisper와 RNNoise도 저장소가 지정한 커밋으로 준비하며, 일반 개발을 위해 서브모듈을 최신 브랜치로 올릴 필요는 없습니다.

## 개발 중 실행

```bash
# Vite와 Tauri 앱 함께 실행
npm run tauri -- dev

# 프런트엔드만 실행: Vite 포트 1420
npm run dev
```

프런트엔드만 실행하면 Tauri IPC가 필요한 클립보드·음성·네이티브 설정 기능은 사용할 수 없습니다. 앱의 기본 창은 숨겨진 상태로 시작하므로 트레이 아이콘으로 창을 열고, 트레이 메뉴의 **설정…**에서 설정합니다.

API 번역을 실제로 실행하려면 해당 공급자의 키 또는 실행 중인 Ollama 서버가 필요합니다. 기본 테스트는 모의 응답을 사용합니다. Whisper 음성을 직접 확인할 때는 설정에서 모델을 다운로드하고, 기능에 필요한 macOS 권한을 허용합니다. 모델·마이크·권한과 실앱 점검 순서는 [받아쓰기 안내](GLOBAL_DICTATION.md)에 있습니다.

설정과 API 키는 현재 앱 데이터 디렉토리의 `settings.json`에 저장되며 Keychain 저장은 아직 구현되어 있지 않습니다. 개발 중 생성한 설정 파일과 실제 인증값을 저장소나 재현 자료에 추가하지 마세요.

## 빌드와 서명

```bash
# 프런트엔드 파일 생성: dist/
npm run build

# 네이티브 앱과 설치 패키지 생성
npm run tauri -- build
```

`npm run build`는 타입 검사를 포함하지 않으므로 `npm run typecheck`를 별도로 실행합니다.

기본 `src-tauri/tauri.conf.json`은 로컬 개발용 `Transrator Developer` 서명 identity를 지정합니다. 이 인증서가 없는 환경에서 빌드를 확인하려면 저장소의 CI overlay를 명시해 ad-hoc 서명 앱을 만들 수 있습니다.

```bash
npm run tauri -- build --ci --bundles app \
  --config "$PWD/src-tauri/tauri.ci.conf.json" -- --locked
```

이 명령은 저장소 루트에서 실행합니다. overlay가 서명 identity를 `-`로 덮어쓰며 별도의 Apple 배포 인증서를 요구하지 않습니다. 이 산출물은 개발·빌드 확인용입니다. 사용자 배포용 Developer ID 서명·공증과 GitHub Draft Release는 [릴리즈 절차](RELEASING.md)에서 다룹니다.

## 변경 검증

프런트엔드 코드 변경의 기본 검사는 다음과 같습니다.

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

관련 테스트를 먼저 실행하며 수정하고, PR 제출 전에는 영향을 받는 검사 범위를 확인합니다. 프런트엔드 변경을 반복해서 확인할 때는 `npm run test:watch`를 사용할 수 있습니다.

macOS 네이티브 코드를 바꿨다면 관련 상태 검사와 Rust 테스트도 실행합니다. 아래 명령은 프런트엔드 빌드 후 실행할 수 있습니다.

```bash
bash tests/run_native_dictation_tests.sh
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
```

Swift FFI, 캡처·클립보드·단축키·창 수명주기를 바꾸면 실제 앱에서도 해당 흐름을 확인합니다. UI 문구·스타일 또는 문서만 바꿨다면 확인한 화면·링크와 생략한 검사 이유를 PR에 남깁니다. 변경과 관련 없는 음성 모델 다운로드나 모든 플랫폼의 반복 검사를 기본 요건으로 두지는 않습니다.

| 검사 | 확인하는 내용 | 포함하지 않는 내용 |
| --- | --- | --- |
| TypeScript·Vitest | API 파싱, 설정, 백엔드 선택, Tauri 모의 호출과 프런트엔드 수명주기 | 실제 공급자 인증·요금·네이티브 장치 동작 |
| Rust 단위 테스트 | 응답·스트림 파싱, 재시도, 단축키 등록·복구, 모델 선택·설치 보호 규칙 | 외부 앱과 실제 마이크를 이용한 입력 |
| 네이티브 검사 스크립트 | 순수 Swift 정책, 실제 AppKit private pasteboard, Python benchmark runner 회귀 | 사용자 일반 클립보드, 마이크 캡처, 모델 기반 인식 |
| 오프라인 WAV 검사 | 실제 Whisper·CoreML 경로의 결과와 처리 시간 | 실시간 녹음 종료 지연, 외부 앱 삽입, 자연 발화 전반의 정확도 |
| 실앱 수동 확인 | 권한, 마이크·창·단축키, 대상 앱 입력과 복사 복구 | 확인하지 않은 OS·장치·입력창에 대한 보장 |

오프라인 음성 검사와 선택형 모델 수명주기 스모크 테스트는 [받아쓰기 개발 검증](GLOBAL_DICTATION.md#개발-중-검증)을 참고하세요. 기존 일본어 WER/CER 도구와 별도 Python 의존성은 [tests/README.md](../tests/README.md)에 있습니다. 개인 음성·인식 정답·출력이 들어간 보고서는 로컬에 보관하고 공개 fixture로 추가하지 않습니다.

## CI에서 확인하는 범위

[Checks workflow](../.github/workflows/checks.yml)는 PR과 `main` push에서 프런트엔드 검사·빌드, macOS 네이티브 정책 검사를 실행합니다. [macOS release workflow](../.github/workflows/release.yml)는 관련 경로가 바뀐 PR과 수동 실행에서 버전·테스트와 Apple Silicon app·DMG 빌드를 추가 확인합니다. 이 경로는 배포 자격 증명을 사용하지 않고 ad-hoc 산출물을 workflow artifact로 남깁니다.

버전 태그 경로는 배포 서명·공증과 검증이 끝난 뒤 Draft Release를 만듭니다. CI 성공과 artifact 생성만으로 실제 설치·권한·음성 입력 확인이 완료되는 것은 아닙니다. 트리거, 비밀값과 공개 전 점검은 [릴리즈 절차](RELEASING.md)를 기준으로 확인하세요.

## 코드 구조

```text
src/
  main.ts                 초기화, 수동 입력, 키보드 이벤트
  api.ts / prompts.ts     번역·요약·필기 인식 작업과 프롬프트
  llmBackend.ts           백엔드 선택과 snapshot 기준 캐시
  providerRegistry.ts     공급자별 protocol·인증 종류·factory
  connectionProfiles.ts   기존 설정의 읽기 전용 프로필과 runtime snapshot
  *Client.ts              Gemini·OpenAI·Ollama 요청과 스트림 처리
  clipboardTranslate.ts   클립보드 번역 흐름
  ui.ts / styles.css      대화 렌더링, 표 처리, 테마
  settings.ts / store.ts  설정 UI와 저장소 접근
  speechInput.ts          앱 안 마이크 입력과 상태 polling
  appCaptions.ts          앱 오디오 자막·번역 큐와 렌더링
  handwriting*.ts         필기 패널과 전체 화면 오버레이
src-tauri/
  src/lib.rs              Tauri 명령 등록, 트레이와 창 수명주기
  src/shortcut.rs         전역 단축키와 선택 영역 복사
  src/dictation.rs        전역 받아쓰기 네이티브 조정
  src/model_manager.rs    Whisper 다운로드·로드·유휴 해제
  src/openai.rs           Rust의 OpenAI HTTP·스트리밍
  swift/                  음성 캡처, Whisper·VAD, 받아쓰기 패널과 입력
  build.rs                Whisper·RNNoise·Swift 빌드와 연결
  vendor/                 네이티브 서브모듈과 VAD 리소스
tests/                    프런트엔드·네이티브 검사와 음성 fixture
```

프런트엔드는 프레임워크 없이 DOM을 조작하고 CSS 변수로 테마를 적용합니다. 명령은 Tauri `invoke`, 실시간 알림은 이벤트와 IPC Channel로 주고받습니다. Gemini·Ollama HTTP는 프런트엔드에서, OpenAI HTTP는 Rust에서 실행합니다.

현재 ConnectionProfile은 기존 설정을 한 번의 `store:entries` 호출로 읽어 투영합니다. 별도 프로필 레코드를 저장해 기존 설정 UI와 경쟁하지 않으며, capability 조회와 텍스트·스트림·이미지 생성은 동일한 고정 설정을 사용합니다. 공개 프로필에는 인증 참조만 있고 원문 키는 runtime의 비공개 값으로 분리합니다. API 키의 영속 저장 위치는 아직 기존 Store이며 Keychain 이전은 후속 단계입니다. 로컬 실행 선택지와 Ollama cloud 구분은 [로컬 모델 안내](LOCAL_MODELS.md)에 정리했습니다.

전역 받아쓰기는 숨겨진 webview의 polling에 의존하지 않는 네이티브 세션입니다. 마이크 입력·전역 받아쓰기·앱 자막은 Whisper 엔진을 공유합니다. 취소된 세션의 결과가 새 세션으로 전달되지 않도록 generation과 소유권 검사를 유지하며, 모델의 추론·교체·해제를 동시에 수행하지 않습니다. 자세한 코드 작업 규칙은 [AGENTS.md](../AGENTS.md)에 있습니다.
