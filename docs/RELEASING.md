# macOS 릴리즈 절차

Transrator의 첫 배포 경로는 **검토한 main 커밋 → 버전 태그 → Apple Silicon DMG 빌드·서명·공증 → GitHub Draft Release → 설치 확인 후 수동 공개**입니다. 앱 안 자동 업데이트와 Intel·Windows·Linux 배포는 이 절차에 포함하지 않습니다.

## 실행 조건

| 이벤트 | 동작 |
| --- | --- |
| 앱·빌드·릴리즈 관련 PR | 버전 일치, 프런트엔드·네이티브 검사, ad-hoc 서명 app·DMG 빌드, workflow artifact 업로드 |
| Actions에서 수동 실행 | 선택한 ref를 같은 build-only 경로로 검사하며 Release를 만들지 않음 |
| vX.Y.Z 태그 push | 세 가지 앱 버전 및 npm lock 버전을 비교하고, 태그 커밋이 main 이력에 포함되는지 확인한 뒤 배포 서명·공증·Draft 작성 |

빌드는 GitHub의 ARM64 macos-15에서 aarch64-apple-darwin 대상으로 수행합니다. npm ci와 Cargo --locked를 사용하고, 네이티브 서브모듈은 저장소가 지정한 커밋으로 재귀 초기화합니다. 현재 Actions에 고정한 action SHA는 업데이트 PR에서 검토해 변경합니다.

PR과 수동 실행은 Apple 비밀값이나 Release 쓰기 토큰을 받지 않습니다. 이 경로의 ad-hoc 서명 산출물은 빌드 확인용이며, 정식 배포 서명·공증을 대신하지 않습니다.

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

버전 변경을 PR로 올리고 검사 후 main에 머지합니다. package.json, package-lock.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock, src-tauri/tauri.conf.json을 함께 갱신합니다. 태그는 stable vX.Y.Z 형식만 사용하며 beta·rc 태그는 현재 절차에서 거절합니다.

Python 3.11 이상으로 버전과 태그를 로컬에서도 검사할 수 있습니다. 아래 버전은 예시이며, 이 절차를 추가한다고 자동으로 태그를 발행하지 않습니다.

```bash
git switch main
git pull --ff-only
python3.11 scripts/check_release_version.py --tag v0.3.0
git tag -a v0.3.0 -m "Transrator 0.3.0"
git push origin v0.3.0
```

태그 job은 모델을 다운로드하거나 마이크를 녹음하지 않습니다. 테스트 통과 후 Tauri가 앱 서명·공증을 수행하고, DMG 컨테이너도 별도로 공증·staple합니다. 앱 codesign·stapler·Gatekeeper 검사와 DMG codesign·stapler 검사가 성공한 다음 Draft와 SHA256SUMS.txt를 만듭니다. 앱 버전 검사는 lock 파일의 npm root version까지 확인하며, Rust lock 파일은 Cargo --locked 검사로 확인합니다.

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

