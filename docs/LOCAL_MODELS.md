# 로컬 모델 연결 방향

2026-10-25 기준 공식 문서·소스를 조사했습니다. Ollama는 **사용자가 설치한 로컬 모델을 실행하는 연결**로 유지합니다. 이번 연결 구조 변경은 기존 모델·주소를 보존하며, 다른 제공자로 자동 전환하지 않습니다. 서버 설치·모델 다운로드·사용자 서버 설정 변경은 수행하지 않습니다.

## Ollama를 로컬 전용으로 사용하기

기본 주소는 `http://localhost:11434`입니다. 사용자가 저장한 LAN 주소와 reverse proxy 경로도 유지합니다. LAN 주소는 다른 기기의 서버일 수 있으므로 같은 Mac에서의 오프라인 추론으로 보장하지 않습니다.

Ollama는 cloud 모델도 지원합니다. 따라서 localhost에 연결했다는 사실만으로 추론이 로컬이라고 확정할 수 없습니다. [공식 FAQ](https://docs.ollama.com/faq)는 로컬 전용 사용에 `OLLAMA_NO_CLOUD=1` 또는 `~/.ollama/server.json`의 `disable_ollama_cloud: true`와 서버 재시작을 안내합니다.

직접 `ollama serve`를 실행하는 경우에는 기존 서버를 종료한 뒤 다음과 같이 시작할 수 있습니다.

```bash
OLLAMA_NO_CLOUD=1 ollama serve
```

앱/서비스로 실행한다면 공식 안내에 따라 서버 설정에 `disable_ollama_cloud`를 추가하고 Ollama를 재시작하세요. 기존 설정의 다른 항목은 유지합니다. Transrator가 이 설정을 대신 수정하거나 실행 중인 서버를 종료하지는 않습니다. 사용할 로컬 모델은 미리 다운로드해야 합니다.

[Ollama Cloud 설명](https://docs.ollama.com/cloud)과 [OpenAI 호환 범위](https://docs.ollama.com/api/openai-compatibility)도 참고하세요. 현재 Transrator는 Ollama의 `/v1/chat/completions`, 모델 목록 `/api/tags`, 이미지 capability 조회 `/api/show`를 사용합니다.

## 대안 비교와 제안

| 실행 방법 | 장점과 운영 경계 | Transrator 적용 방향 |
| --- | --- | --- |
| **Ollama** | 기존 daemon·모델을 그대로 사용. 모델별 이미지 지원을 확인해야 함 | 현재 기본 로컬 연결 유지 |
| **LM Studio** | GUI에서 모델 관리, Apple Silicon의 GGUF/MLX runtime, 로컬 OpenAI 호환 서버 | 다음 공통 OpenAI 호환 연결에 프리셋 추가 권장 |
| **llama.cpp / llama-server** | GGUF·Metal·서버 옵션을 직접 관리. 이미지 모델은 대응 projector 등이 필요할 수 있음 | 사용자가 실행한 서버에 명시적 endpoint로 연결하는 고급 옵션 |
| **MLX-LM** | Apple Silicon용 MLX 모델을 직접 운영. Python·모델 파일·tokenizer와 버전 관리 필요 | 외부 서버 연결부터 검토하고 앱 내장 runtime은 별도 과제로 평가 |

Ollama 유지 후 LM Studio 옵션을 추가하는 순서를 권장합니다. 현재 번역 기능을 유지하면서 모델 관리 UI의 선택지를 늘릴 수 있기 때문입니다. 이는 성능 벤치마크 결론이 아닙니다. 모델·양자화·문맥·cold/warm 상태·Whisper 동시 사용 조건을 맞추기 전에는 특정 runtime이 더 빠르다거나 메모리가 충분하다고 단정하지 않습니다.

LM Studio·llama-server·MLX 서버는 이번 Registry 기반 PR에서 새로 추가하는 기능이 아닙니다. [모델 연결 계획 #6](https://github.com/ykworx/translator/issues/6)의 공통 호환 adapter·연결 UI 단계에서 다룹니다. OpenAI 호환 endpoint라도 이미지·reasoning·JSON schema 지원은 같지 않으므로 실제 지원 기능을 별도로 확인합니다.

공식 자료:

- [LM Studio 앱·GGUF/MLX](https://lmstudio.ai/docs/app), [로컬 서버](https://lmstudio.ai/docs/developer/core/server), [OpenAI 호환 API](https://lmstudio.ai/docs/developer/openai-compat), [오프라인 사용](https://lmstudio.ai/docs/app/offline)
- [llama.cpp Metal 빌드](https://github.com/ggml-org/llama.cpp/blob/74bca3950054eed1795f525cb9cf06bfe796492d/docs/build.md#metal-build), [llama-server](https://github.com/ggml-org/llama.cpp/blob/74bca3950054eed1795f525cb9cf06bfe796492d/tools/server/README.md), [이미지 모델](https://github.com/ggml-org/llama.cpp/blob/74bca3950054eed1795f525cb9cf06bfe796492d/tools/mtmd/README.md)
- [MLX-LM](https://github.com/ml-explore/mlx-lm/blob/4cfc6478473b0668ede3eb0cc93f2a9181a15052/README.md), [서버의 이미지 처리](https://github.com/ml-explore/mlx-lm/blob/4cfc6478473b0668ede3eb0cc93f2a9181a15052/mlx_lm/server.py#L648-L689)

MLX-LM의 현재 소스에는 제한된 processor를 사용하는 이미지 처리도 있습니다. 모든 모델에서 이미지가 지원된다고 가정하거나, 반대로 서버 전체를 항상 텍스트 전용으로 분류하지 않습니다.

## 향후 엄격한 로컬 전용 모드

현재 설정의 주소나 모델 이름을 자동으로 바꾸지 않습니다. 엄격한 로컬 전용 모드를 추가할 때는 서버 버전과 모델의 원격 metadata를 함께 확인해야 합니다.

Ollama v0.40.11 소스의 `/api/tags` 응답에는 `remote_host`·`remote_model`이 있습니다. 원격 alias도 이 metadata를 반환하므로 이름의 `cloud` suffix만 확인하는 것보다 정확한 식별에 사용할 수 있습니다. `/api/show`는 원격 모델 상세를 cloud에서 조회할 수도 있어 사전 분류에는 tags가 적합합니다. metadata가 없다는 사실만으로 임의 proxy나 모든 구버전의 로컬 실행을 보장하지는 않습니다.

같은 버전의 native `/api/chat`·`/api/generate`에는 모델 참조의 `:local` source intent로 원격 alias를 거절하는 구현이 있습니다. 임의의 `local_only` 요청 필드를 추가하거나 기존 모델 이름에 suffix를 붙여 모든 버전에서 지원되는 옵션처럼 처리하지 않습니다. 현재 앱의 OpenAI 호환 경로에 그대로 적용된다고도 가정하지 않습니다.

- [원격 모델 metadata](https://github.com/ollama/ollama/blob/675150d6ad2747df1e218ef59de9194bc4a7e538/api/types.go#L932-L941)
- [alias의 원격 metadata 반환](https://github.com/ollama/ollama/blob/675150d6ad2747df1e218ef59de9194bc4a7e538/server/model_list.go#L184-L188)
- [local source parser](https://github.com/ollama/ollama/blob/675150d6ad2747df1e218ef59de9194bc4a7e538/internal/modelref/modelref.go#L99-L117), [native chat의 원격 alias 거절](https://github.com/ollama/ollama/blob/675150d6ad2747df1e218ef59de9194bc4a7e538/server/routes.go#L3072-L3075)
