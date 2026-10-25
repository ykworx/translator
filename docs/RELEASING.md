# macOS 릴리즈 절차

Transrator의 첫 배포 경로는 **검토한 main 커밋 → 버전 태그 → Apple Silicon DMG 빌드·서명·공증 → GitHub Draft Release → 설치 확인 후 수동 공개**입니다. 앱 안 자동 업데이트와 Intel·Windows·Linux 배포는 이 절차에 포함하지 않습니다.

## 실행 조건

| 이벤트 | 동작 |
| --- | --- |
| 앱·빌드·릴리즈 관련 PR | 버전 일치, 프런트엔드·네이티브 검사, ad-hoc 서명 app·DMG 빌드, workflow artifact 업로드 |
| Actions에서 수동 실행 | 선택한 ref를 같은 build-only 경로로 검사하며 Release를 만들지 않음 |
| vX.Y.Z 태그 push | npm·Cargo·Tauri·각 lock 버전과 태그를 비교하고, 태그 커밋이 main 이력에 포함되는지 확인한 뒤 배포 서명·공증·Draft 작성 |

빌드는 GitHub의 ARM64 macos-15에서 aarch64-apple-darwin 대상으로 수행합니다. npm ci와 Cargo --locked를 사용하고, 네이티브 서브모듈은 저장소가 지정한 커밋으로 재귀 초기화합니다. 현재 Actions에 고정한 action SHA는 업데이트 PR에서 검토해 변경합니다.

PR과 수동 실행은 Apple 비밀값이나 Release 쓰기 토큰을 받지 않습니다. 이 경로의 ad-hoc 서명 산출물은 빌드 확인용이며, 정식 배포 서명·공증을 대신하지 않습니다.

같은 PR에 새 커밋을 올리면 이전 커밋의 패키징 검사는 취소하고 최신 커밋을 검사합니다. 버전 태그의 배포 실행은 같은 태그의 기존 실행을 자동 취소하지 않습니다.

## 최초 준비

정식 배포에는 유효한 Apple Developer의 Developer ID Application 인증서와 공증 자격 증명이 필요합니다. 저장소 Settings → Secrets and variables → Actions에 다음 비밀값을 관리자가 직접 등록합니다. 이 변경은 인증서를 추출하거나 업로드하지 않습니다.

| Secret | 내용 |
| --- | --- |
| APPLE_CERTIFICATE | 관리자 승인 아래 내보낸 .p12 인증서·개인 키의 base64 |
| APPLE_CERTIFICATE_PASSWORD | 위 .p12를 보호하는 암호 |
| APPLE_SIGNING_IDENTITY | Developer ID Application: 으로 시작하는 실제 서명 identity |
| APPLE_ID | 공증에 사용할 Apple 계정 |
| APPLE_PASSWORD | 해당 계정의 앱 암호(app-specific password) |
| APPLE_TEAM_ID | Apple 개발자 팀 ID |

GITHUB_TOKEN은 Actions가 제공하므로 별도의 개인 토큰을 등록하지 않습니다. 태그 job에서만 contents: write를 사용합니다. 필요한 비밀값이 없거나 identity가 Developer ID Application이 아니면 배포 빌드 전에 실패합니다.

로컬 tauri.conf.json의 Transrator Developer는 기존 개발 환경용입니다. 태그 job은 RUNNER_TEMP에 JSON overlay를 생성해 실제 배포 identity로 명시적으로 덮어씁니다. PR overlay는 identity를 -로 설정합니다. hardened runtime에서 마이크 입력이 가능하도록 release용 entitlement에 com.apple.security.device.audio-input을 넣습니다. 이 entitlement는 사용자의 macOS 마이크 허용을 대신하지 않습니다.

필요하면 GitHub의 태그 ruleset으로 v* 태그 작성 권한과 변경을 제한합니다. Apple 자격 증명을 처음 넣거나 바꾸는 작업은 관리자가 수행합니다.

## 버전 준비와 태그

`src-tauri/tauri.conf.json`의 version이 기준입니다. 아래 명령으로 package.json, package-lock.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock까지 동기화하고 [CHANGELOG](../CHANGELOG.md)에 사용자에게 보이는 변경을 작성합니다. 스크립트는 커밋이나 태그를 만들지 않습니다. 버전 변경을 Release PR로 올리고 검사·독립 리뷰 후 main에 머지합니다.

```bash
python3.11 scripts/prepare_release.py --version 0.3.0
python3.11 scripts/check_release_version.py
```

SemVer의 `MAJOR.MINOR.PATCH`를 사용합니다. 새 기능은 `0.2.0 → 0.3.0`, 호환되는 오류 수정은 `0.3.0 → 0.3.1`, 안정된 공개 계약을 약속하는 시점에 `1.0.0`으로 올립니다. 0.x에서 호환되지 않는 설정·연결 변경은 minor를 올리고 이전 방법과 마이그레이션을 기록합니다. 공개한 버전·태그·파일은 바꾸지 않고 새 버전을 냅니다. 태그는 stable vX.Y.Z 형식만 사용하며 beta·rc 태그는 현재 절차에서 거절합니다.

설정의 정보 탭은 실행 파일에 포함된 버전·커밋·빌드 시각을 표시합니다. 로컬 빌드는 `개발 빌드`와 추적 중인 소스의 수정 여부를 표시합니다(추적하지 않는 파일은 제외). 소스 압축본처럼 Git 정보가 없으면 이를 명시합니다. CI는 `검증 빌드`와 `릴리스 빌드`를 구분하고, macOS CFBundleVersion과 내장 메타데이터에 `workflow run_number.run_attempt`를 넣습니다. 예: `42.1`, 재시도 `42.2`. 빌드 번호는 앱의 SemVer와 별개이며 동일 워크플로의 다음 실행에서 증가합니다. run_number 1..9999, run_attempt 1..99만 허용하며 한계에 도달하기 전에 번호 정책을 갱신해야 합니다. 워크플로를 새로 만들거나 이름을 바꿀 때도 카운터 연속성을 검토합니다. 로컬 macOS 번들의 기본 CFBundleVersion은 Tauri의 기본 버전 매핑을 사용합니다.

CI는 clean Git 소스와 빌드 번호를 요구하고, 패키지의 Info.plist와 실행 파일의 `--build-info` 출력까지 비교합니다. 이 진단 명령은 앱·마이크·설정·Keychain을 초기화하지 않습니다.

Python 3.11 이상으로 버전과 태그를 로컬에서도 검사할 수 있습니다. 아래 버전은 예시이며, 이 절차를 추가한다고 자동으로 태그를 발행하지 않습니다.

```bash
git switch main
git pull --ff-only
python3.11 scripts/check_release_version.py --tag v0.3.0
git tag -a v0.3.0 -m "Transrator 0.3.0"
git push origin v0.3.0
```

태그 job은 모델을 다운로드하거나 마이크를 녹음하지 않습니다. 테스트 통과 후 Tauri가 앱 서명·공증을 수행하고, DMG 컨테이너도 별도로 공증·staple합니다. 앱 codesign·stapler·Gatekeeper 검사와 DMG codesign·stapler 검사, 번들의 버전·빌드 식별 검증이 성공한 다음 Draft와 SHA256SUMS.txt를 만듭니다.

## Draft 검토와 공개

Actions 성공 후 저장소 Releases의 Draft에서 변경 내역을 확인하고, DMG를 내려받아 새 설치로 실행합니다. 마이크·손쉬운 사용 권한, 전역 받아쓰기 시작·종료·취소, TextEdit·브라우저 입력, 복사 복구와 클립보드 보존을 확인합니다. 실제 기기 검증 범위는 docs/GLOBAL_DICTATION.md의 점검표를 사용합니다.

확인이 끝나면 관리자가 Draft를 공개합니다. 태그 workflow 자체는 공개 버튼을 누르지 않습니다. 자동 생성된 변경 내역도 배포 전에 읽고 보완합니다. 해시는 다운로드 파일이 릴리즈 산출물과 같은지 확인하는 보조 수단이며, 서명 검증을 대신하지 않습니다.

## 실패와 재실행

서명·공증·검사가 실패하면 Draft 작성 단계로 진행하지 않습니다. Apple 공증은 처음 제출할 때 오래 걸릴 수 있으므로 Actions 로그에서 실패 단계를 확인합니다. 실패한 태그 실행은 문제를 해결한 뒤 재실행할 수 있으며 기존 Draft 자산만 갱신합니다. 이미 공개한 Release는 재실행으로 덮어쓰지 않습니다. 공개 후 수정은 새 버전·새 태그로 배포합니다.

수동 workflow_dispatch는 릴리즈를 재발행하는 경로가 아닙니다. 실제 Apple 인증서와 공증 자격 증명 없이 가능한 검증은 ad-hoc 패키징까지입니다.

## 공식 문서

- [Tauri GitHub pipeline](https://v2.tauri.app/distribute/pipelines/github/)
- [tauri-action inputs와 Draft Release](https://github.com/tauri-apps/tauri-action)
- [Tauri macOS 서명·공증](https://v2.tauri.app/distribute/sign/macos/)
- [GitHub 호스티드 runner 아키텍처](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [Apple Audio Input entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input)
- [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
- [Tauri version 설정](https://v2.tauri.app/reference/config/#version)

Release Please 같은 자동 Release PR 도구는 추후 검토합니다. 현재는 버전 준비 스크립트와 명시적 Release PR을 사용합니다. 자동화할 때는 GITHUB_TOKEN으로 만든 태그가 일반 push workflow를 다시 실행하지 않는 제약을 고려해 workflow 호출 방식을 함께 설계해야 합니다.

