# 연결·인증

## API 키 사용

macOS에서 Gemini·OpenAI API 키는 Keychain에 저장합니다. **설정 → API**에서 사용할 제공자를 선택하면 저장된 키의 상태를 확인합니다. 키 원문은 다시 표시하지 않습니다.

- 새 키를 입력한 뒤 **API 키 저장**을 누르면 일반 설정과 별도로 즉시 적용합니다.
- 입력칸이 비어 있으면 저장된 키를 유지합니다. 언어·모델·단축키의 일반 저장은 키를 변경하지 않습니다.
- **저장된 키 삭제**는 표시된 확인 절차 후 현재 연결의 키를 삭제합니다. 새 요청에서는 해당 연결을 사용할 수 없습니다. 이미 시작한 요청은 완료될 수 있습니다.
- 키 상태 확인이나 저장이 실패하면 입력을 유지합니다. Keychain 접근 권한을 확인한 뒤 **키 상태 확인**으로 다시 읽고 저장하세요.
- Keychain 항목이 사라진 경우에는 오류를 표시합니다. 새 키를 입력하고 저장하면 연결을 복구할 수 있습니다.

다른 창에서 키를 바꾸었다면 오래된 창의 저장·삭제를 거절합니다. 상태를 다시 확인한 뒤 변경하세요. 앱 서명이나 Keychain 설정에 따라 macOS의 접근 허용 창이 나타날 수 있습니다.

## 기존 키 이전

이전 버전의 `settings.json`에 키가 있으면 해당 cloud 제공자의 **키 상태 확인 또는 첫 사용** 시 이전합니다. 다른 제공자의 키를 함께 읽거나 Ollama 사용 중에 이전하지 않습니다.

1. 새 Keychain 항목에 쓰고 같은 값을 다시 읽어 확인합니다.
2. 키 원문이 없는 인증 참조를 `auth-profiles.json`에 저장하고 다시 확인합니다.
3. 이전 평문 키를 `settings.json`에서 제거하고 파일을 저장합니다.

중간 실패 시 확인된 Keychain 항목과 인증 참조 또는 이전 원본을 복구에 사용합니다. 잠김·거부를 “키 없음”으로 처리하거나 다른 backend로 전환하지 않습니다. 이전이 끝나지 않은 제공자의 평문 키는 기존 파일에 남아 있을 수 있습니다. 설정 파일과 백업을 공개하지 마세요.

Keychain 항목이 없거나 기존 설정과 충돌할 때는 키 상태 확인·명시적 재저장으로 복구할 수 있습니다. 인증 참조 파일 자체가 손상되면 자동 덮어쓰기와 재저장을 중단합니다. 손상된 파일을 임의로 지우는 자동 복구는 제공하지 않습니다. 문제 신고 시 실제 설정 파일이나 키를 공유하지 말고 비밀값을 제외한 오류 메시지와 재현 절차만 남겨주세요.

## Ollama와 지원 범위

로컬 LLM은 **Ollama만 지원**합니다. API 키가 필요하지 않으며 cloud 인증 작업의 잠김·거부와 독립적으로 연결합니다. 서버 주소·선택 모델과 LAN/proxy 경로를 유지합니다. 로컬 전용 실행 설정은 [Ollama 안내](LOCAL_MODELS.md)를 참고하세요.

현재 Keychain 기반 cloud 인증은 macOS에서 지원합니다. 다른 운영체제에서는 보안 cloud 인증이 지원되지 않는다는 오류를 표시하고 평문 저장으로 대체하지 않습니다. Ollama와 일반 설정은 이 제한과 별개입니다.

## 개발·검증 경계

저장된 키는 프런트엔드에 반환하지 않습니다. 새로 입력한 키만 저장 명령에 전달하고, 생성 요청에는 Rust에 고정된 모델·키를 참조하는 runtime ID를 사용합니다. Gemini·OpenAI는 고정된 공식 endpoint에서 요청하며 redirect를 따르지 않습니다. Gemini 키는 URL 쿼리 대신 공식 인증 헤더로 보냅니다. [Gemini API 인증](https://ai.google.dev/api#authentication)

runtime은 프로세스 안에서만 유효하며 최대 128개를 보관합니다. 키 교체 중 진행 중인 요청은 기존 snapshot을 유지합니다. 사용자가 명시적으로 키를 삭제하면 해당 제공자의 ID를 무효화합니다. Keychain을 잠그는 것만으로 이미 시작한 요청이나 메모리에 복사된 키가 즉시 취소되는 것은 아닙니다.

교체나 저장 실패로 생긴 미참조 Keychain 항목의 자동 정리는 후속 과제입니다. 현재 삭제는 활성 항목과 해당 제공자의 runtime을 대상으로 하며, 모든 과거 항목의 물리적 제거를 보장하지 않습니다. 여러 일반 설정 키의 저장과 복수 연결 프로필을 하나의 transaction으로 관리하는 기능도 후속입니다.

기본 검사는 가짜 vault·임시 파일·로컬 HTTP fixture를 사용합니다. 사용자 Keychain·실제 API 키·유료 요청을 사용하지 않습니다. 자동 검사 통과는 실제 Keychain 권한·서명 연속성 검증을 대신하지 않습니다.

릴리스 전에는 격리된 macOS 환경에서 가짜 키로 첫 저장, Deny/Cancel, Keychain 잠금, 동일 서명 업데이트와 개발 서명→배포 서명 전환을 확인합니다. 기본 API는 macOS의 파일 기반 Keychain과 ACL을 사용하므로 화면 잠금과 동일한 조건으로 간주하지 않습니다. 앱 이름·bundle ID만 같다고 서명 변경 후 접근이 보장되지도 않습니다. [Apple Keychain 구분](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains), [서명과 Keychain 접근](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/AboutCS/AboutCS.html)

실제 Keychain 자동 실험은 별도 runner/VM에서 추가·조회 대상을 임시 Keychain으로 제한합니다. 사용자 login Keychain, 전역 default/search-list 변경, LockAll은 사용하지 않습니다.
