# Ollama 로컬 모델 연결

2026-10-25 결정: 로컬 LLM 실행은 **Ollama만 지원**합니다. 다른 로컬 LLM 서버 프리셋이나 앱 내장 LLM runtime은 도입 범위에서 제외합니다. 받아쓰기의 로컬 Whisper 사용은 별도 기능으로 유지합니다. Ollama는 사용자가 설치한 로컬 모델을 실행하는 연결입니다. 이번 연결 구조 변경은 기존 모델·주소를 보존하며, 다른 제공자로 자동 전환하지 않습니다. 서버 설치·모델 다운로드·사용자 서버 설정 변경은 수행하지 않습니다.

## Ollama를 로컬 전용으로 사용하기

기본 주소는 `http://localhost:11434`입니다. 사용자가 저장한 LAN 주소와 reverse proxy 경로도 유지합니다. LAN 주소는 다른 기기의 서버일 수 있으므로 같은 Mac에서의 오프라인 추론으로 보장하지 않습니다.

Ollama는 cloud 모델도 지원합니다. 따라서 localhost에 연결했다는 사실만으로 추론이 로컬이라고 확정할 수 없습니다. [공식 FAQ](https://docs.ollama.com/faq)는 로컬 전용 사용에 `OLLAMA_NO_CLOUD=1` 또는 `~/.ollama/server.json`의 `disable_ollama_cloud: true`와 서버 재시작을 안내합니다.

직접 `ollama serve`를 실행하는 경우에는 기존 서버를 종료한 뒤 다음과 같이 시작할 수 있습니다.

```bash
OLLAMA_NO_CLOUD=1 ollama serve
```

앱/서비스로 실행한다면 공식 안내에 따라 서버 설정에 `disable_ollama_cloud`를 추가하고 Ollama를 재시작하세요. 기존 설정의 다른 항목은 유지합니다. Transrator가 이 설정을 대신 수정하거나 실행 중인 서버를 종료하지는 않습니다. 사용할 로컬 모델은 미리 다운로드해야 합니다.

[Ollama Cloud 설명](https://docs.ollama.com/cloud)과 [OpenAI 호환 범위](https://docs.ollama.com/api/openai-compatibility)도 참고하세요. 현재 Transrator는 Ollama의 `/v1/chat/completions`, 모델 목록 `/api/tags`, 이미지 capability 조회 `/api/show`를 사용합니다.

## Ollama 사용성 개선 방향

[모델 연결 계획 #6](https://github.com/ykworx/translator/issues/6)의 연결 UI 단계에서 Ollama 서버 주소·모델 선택·연결 확인을 쉽게 사용할 수 있도록 개선합니다.

- 저장한 주소·모델을 보존하고 서버 연결 상태와 사용 가능한 모델을 확인할 수 있는 화면
- 서버 미실행·모델 미설치·통신 지연을 구분하는 안내
- 선택 모델의 텍스트·이미지·스트림 지원 여부 확인
- Whisper 받아쓰기와 함께 사용할 때의 응답 시간·메모리 사용 검증

이는 후속 구현 방향입니다. 현재 추가된 기능으로 표시하지 않으며, 서버 설치·모델 다운로드·서버 설정 변경을 자동으로 수행하지 않습니다.

## 향후 엄격한 로컬 전용 모드

현재 설정의 주소나 모델 이름을 자동으로 바꾸지 않습니다. 엄격한 로컬 전용 모드를 추가할 때는 서버 버전과 모델의 원격 metadata를 함께 확인해야 합니다.

Ollama v0.40.11 소스의 `/api/tags` 응답에는 `remote_host`·`remote_model`이 있습니다. 원격 alias도 이 metadata를 반환하므로 이름의 `cloud` suffix만 확인하는 것보다 정확한 식별에 사용할 수 있습니다. `/api/show`는 원격 모델 상세를 cloud에서 조회할 수도 있어 사전 분류에는 tags가 적합합니다. metadata가 없다는 사실만으로 임의 proxy나 모든 구버전의 로컬 실행을 보장하지는 않습니다.

같은 버전의 native `/api/chat`·`/api/generate`에는 모델 참조의 `:local` source intent로 원격 alias를 거절하는 구현이 있습니다. 임의의 `local_only` 요청 필드를 추가하거나 기존 모델 이름에 suffix를 붙여 모든 버전에서 지원되는 옵션처럼 처리하지 않습니다. 현재 앱의 OpenAI 호환 경로에 그대로 적용된다고도 가정하지 않습니다.

- [원격 모델 metadata](https://github.com/ollama/ollama/blob/675150d6ad2747df1e218ef59de9194bc4a7e538/api/types.go#L932-L941)
- [alias의 원격 metadata 반환](https://github.com/ollama/ollama/blob/675150d6ad2747df1e218ef59de9194bc4a7e538/server/model_list.go#L184-L188)
- [local source parser](https://github.com/ollama/ollama/blob/675150d6ad2747df1e218ef59de9194bc4a7e538/internal/modelref/modelref.go#L99-L117), [native chat의 원격 alias 거절](https://github.com/ollama/ollama/blob/675150d6ad2747df1e218ef59de9194bc4a7e538/server/routes.go#L3072-L3075)
