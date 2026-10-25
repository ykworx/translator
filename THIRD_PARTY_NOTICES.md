# 외부 구성 요소 고지

Transrator 본체의 MIT 라이선스는 외부 구성 요소의 라이선스와 저작권을 변경하지 않습니다. 아래는 앱에 직접 포함하는 주요 네이티브 코드와 VAD 모델의 출처입니다. npm·Rust 의존성의 버전은 package-lock.json·src-tauri/Cargo.lock에 기록되며 해당 구성 요소의 라이선스도 적용됩니다.

| 구성 요소 | 출처·원문 고지 |
| --- | --- |
| Whisper.cpp | [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp), 서브모듈 LICENSE 원문 |
| RNNoise | [xiph/rnnoise](https://github.com/xiph/rnnoise), 서브모듈 COPYING 원문 |
| Silero VAD | [snakers4/silero-vad](https://github.com/snakers4/silero-vad), [MIT 원문](licenses/Silero-VAD-LICENSE), Copyright (c) 2020-present Silero Team |
| CoreML Silero VAD 변환 모델 | [FluidInference/silero-vad-coreml](https://huggingface.co/FluidInference/silero-vad-coreml), 모델 카드의 MIT 표시와 Silero Team·FluidAudio 변환 출처 |
| Hermes Agent 모델 연결 계약 | [NousResearch/hermes-agent b02fa6813](https://github.com/NousResearch/hermes-agent/tree/b02fa681328bae7071412677d76448ff46582f68), [MIT 원문](licenses/Hermes-Agent-LICENSE), Copyright (c) 2025 Nous Research |

앱에는 Whisper.cpp의 Silero v6.2.0 ggml 테스트 모델과 FluidInference의 Silero v6.0.0 CoreML 변환 모델이 포함됩니다. CoreML 모델의 원래 author·version·변환 정보는 src-tauri/vendor/silero-vad-coreml.mlmodelc/metadata.json에 유지합니다.

앱의 Contents/Resources/licenses에는 본체 LICENSE, Whisper.cpp LICENSE, RNNoise COPYING, Silero VAD LICENSE, Hermes Agent LICENSE와 이 출처 고지를 함께 포함합니다. CI는 실제 번들의 고지가 저장소 원문과 일치하는지 확인합니다. 사용자가 따로 다운로드하는 Whisper 음성 인식 모델도 해당 배포자의 라이선스와 사용 조건을 따릅니다.

Hermes의 `providers/base.py` ProviderProfile과 `hermes_cli/auth.py` ProviderConfig 계약을 참고해 TypeScript Registry·ConnectionProfile을 구성했습니다. Python 실행기를 포함하거나 OAuth 구현을 복제하지 않고, 기존 Gemini·OpenAI·Ollama adapter를 연결 snapshot으로 실행하도록 구현했습니다. 원본 기준 commit은 위 링크이며, 인증 관리·다중 연결 UI·계정 연결은 [계획 #6](https://github.com/ykworx/translator/issues/6)에서 이어갑니다.
