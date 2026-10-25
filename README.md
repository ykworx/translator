# Transrator

[![Checks](https://github.com/ykworx/translator/actions/workflows/checks.yml/badge.svg?branch=main)](https://github.com/ykworx/translator/actions/workflows/checks.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

선택한 텍스트·표·이미지를 번역하고, 로컬 Whisper 받아쓰기를 다른 앱에서도 사용할 수 있는 macOS 중심의 트레이 앱입니다. Tauri 2와 vanilla TypeScript로 개발합니다.

[사용 및 설정](#사용-및-설정) · [문서](docs/README.md) · [변경 내역](CHANGELOG.md) · [기여하기](CONTRIBUTING.md) · [버그 제보](https://github.com/ykworx/translator/issues/new/choose) · [릴리즈](https://github.com/ykworx/translator/releases)

## 주요 기능

- 선택한 텍스트·HTML 표·클립보드 이미지·캡처 영역 번역
- Gemini API, OpenAI API, Ollama 연결과 텍스트 번역 스트리밍
- 요약, 답장 추천, 발음 표시와 캔버스·전체 화면 필기 인식
- 로컬 Whisper 마이크 입력과 **Cmd+Ctrl+D 전역 받아쓰기**
- 실험적 앱 오디오 자막 번역

마이크·전역 받아쓰기·앱 오디오 자막은 macOS 전용입니다. 현재 자동 패키징 대상은 **Apple Silicon Mac**입니다. Windows/Linux의 번역용 코드 경로는 있지만 이번 macOS 빌드 검증 범위에 포함되지 않습니다. 다른 앱의 입력창은 접근성 정보에 따라 자동 입력 대신 결과 복사 모드를 사용할 수 있습니다.

## 설치 및 실행

[Releases](https://github.com/ykworx/translator/releases)에서 공개 설치파일을 확인하세요. 아직 설치파일이 없거나 개발 버전을 실행하려면 소스에서 시작할 수 있습니다.

macOS에서 Node.js/npm, Rust, Xcode Command Line Tools, CMake를 준비합니다.

```bash
git clone --recurse-submodules https://github.com/ykworx/translator.git
cd translator
npm ci
npm run tauri -- dev
```

로컬 앱 패키징과 개발용 서명 설정은 [개발 안내](docs/DEVELOPMENT.md), GitHub 배포와 필요한 Apple 인증서는 [릴리즈 절차](docs/RELEASING.md)를 참고하세요. PR의 ad-hoc 서명 산출물은 빌드 확인용입니다.

## 사용 및 설정

**받아쓰기만 사용한다면 API 키가 필요하지 않습니다.** 메인 첫 화면의 **받아쓰기 준비** 또는 트레이의 **받아쓰기 준비…**에서 모델·마이크·권한·단축키를 확인하세요. 메인의 **음성** 버튼은 이 창 안의 입력칸용이며, 다른 앱 입력에는 전역 받아쓰기 단축키를 사용합니다. 번역 공급자·키 상태는 **번역 연결 준비**나 설정의 **API** 탭에서 별도로 확인할 수 있습니다.

메인 창의 **⚙ 설정**, 트레이 메뉴의 **설정…**, macOS 앱 메뉴의 **설정…(Cmd+,)**에서 번역 백엔드, API 키, 언어, 단축키를 설정합니다. 숨겨진 앱은 Finder에서 다시 열어 창을 표시할 수 있습니다. Gemini·OpenAI는 해당 API 키가, Ollama는 실행 중인 서버와 모델이 필요합니다. 이미지·필기 인식에는 이미지 입력을 지원하는 모델을 선택합니다.

직접 입력한 내용은 **번역** 버튼이나 Enter로 실행하고, Shift+Enter로 줄바꿈합니다. 한글·일본어 입력 조합을 확정하는 Enter는 번역을 실행하지 않습니다. API 키의 **키만 즉시 저장**·삭제는 바로 적용되며 **설정 취소**로 되돌릴 수 없습니다. 공급자·모델과 일반 설정은 **연결·설정 저장**으로 적용합니다.

| 기본 단축키 | 동작 |
| --- | --- |
| Cmd+Ctrl+T | 선택한 내용을 복사한 뒤 번역 |
| Cmd+Ctrl+Shift+T | 영역 캡처 후 이미지 번역 |
| Cmd+Ctrl+D | 다른 앱에서 받아쓰기 시작·종료 |
| Enter / Shift+Enter | 번역 / 줄바꿈 |
| Cmd+K | 대화 지우기 |
| Cmd+Shift+C | 마지막 번역 복사 |

음성 기능은 **설정 → 받아쓰기**에서 Whisper 모델을 다운로드한 뒤 사용합니다. 언어·마이크·용어 힌트와 모델 유지 시간을 지정할 수 있습니다. 마이크와 손쉬운 사용 권한은 받아쓰기에, 화면 기록 권한은 영역 캡처·앱 오디오 자막에 사용합니다. [전역 받아쓰기 안내](docs/GLOBAL_DICTATION.md)에 사용법과 실제·자동 검증 범위를 정리했습니다.

받아쓰기 인식은 로컬에서 처리하고, 번역은 선택한 백엔드로 입력을 전송합니다. 로컬 LLM은 Ollama만 지원하며, 로컬 전용 설정은 [로컬 모델 안내](docs/LOCAL_MODELS.md)를 참고하세요. macOS의 API 키는 Keychain에 저장하며, 일반 설정은 `settings.json`에 저장합니다. 키 저장·삭제는 설정 화면의 별도 버튼으로 적용합니다. 기존 키의 이전·복구와 플랫폼 지원 범위는 [연결·인증 안내](docs/CONNECTIONS.md)를, 후속 연결 UI 계획은 [이슈 #6](https://github.com/ykworx/translator/issues/6)을 참고하세요.

## 개발과 기여

[개발 안내](docs/DEVELOPMENT.md)에서 프로젝트 구조와 검사 명령을, [기여 안내](CONTRIBUTING.md)에서 이슈·PR 작성 방법을 확인할 수 있습니다. 버그·기능 제안은 [이슈 양식](https://github.com/ykworx/translator/issues/new/choose)을 이용하세요. 보안 취약점은 [비공개 제보 안내](SECURITY.md)를 따릅니다.

CI는 타입 검사·프런트엔드 테스트·빌드와 네이티브 상태·클립보드 검사를 수행합니다. 릴리즈 워크플로는 PR에서 실제 macOS app·DMG 패키징을 확인하고, 버전 태그에서는 배포 서명·공증 후 Draft Release를 만듭니다. 설치 확인 후 공개하는 과정은 [릴리즈 절차](docs/RELEASING.md)에 있습니다.

## 라이선스

Transrator 본체는 [MIT](LICENSE) 라이선스입니다. 포함된 서브모듈, 의존성과 모델 파일에는 각 원 프로젝트의 라이선스가 적용됩니다. [외부 구성 요소 고지](THIRD_PARTY_NOTICES.md)와 원 저작권·허가문을 유지하세요.
