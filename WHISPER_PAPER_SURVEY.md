# Whisper ASR 최신 논문 조사 및 개선책 제안

> 조사일: 2026-03-22
> 프로젝트: Transrator (macOS Tauri, whisper.cpp + CoreML/ANE + Metal, medium-q5_0)
> 현재 지연: ~1.3-1.5s | 목표: 300ms 이하

---

## 1. 스트리밍 / 저지연 디코딩 기법

### 1.1 Whisper-Streaming (LocalAgreement)

- **논문**: "Turning Whisper into Real-Time Transcription System" (Macháček et al., 2023)
- **출처**: INTERSPEECH 2023 | [arXiv:2307.14743](https://arxiv.org/abs/2307.14743)
- **GitHub**: [ufal/whisper_streaming](https://github.com/ufal/whisper_streaming)

**핵심 아이디어**: LocalAgreement-2 정책으로 연속 2회 업데이트가 동일한 접두사를 생성하면 확정. 오프라인 대비 WER +0.2~0.6pp 열화로 실시간 스트리밍 구현.

- **적용 가능성**: 중 (현재 AlignAtt 모드 이미 사용 중, SimulStreaming으로 진화)
- **구체적 적용 방안**: SimulStreaming의 AlignAtt + LocalAgreement 통합 정책을 whisper.cpp 레벨에서 구현
- **예상 효과**: 지연 3.3s → AlignAtt과 결합 시 확정 지연 개선, 하지만 근본적 한계 존재

### 1.2 SimulStreaming (Whisper-Streaming 후속)

- **논문**: "Simultaneous Translation with Offline Speech and LLM Models" (Macháček & Polák, IWSLT 2025)
- **GitHub**: [ufal/SimulStreaming](https://github.com/ufal/SimulStreaming)

**핵심 아이디어**: WhisperStreaming 대비 5x 빠름. Simul-Whisper AlignAtt 정책 + VAD Controller + RAG 기반 도메인 용어 프롬프팅 통합. IWSLT 2025 동시통역 1위.

- **적용 가능성**: 중 (Python 기반, whisper.cpp에 직접 적용 어려움)
- **구체적 적용 방안**: VAD Controller의 무음 구간 스킵 로직과 AlignAtt 정책 최적화를 whisper.cpp 스트리밍 모드에 포팅
- **예상 효과**: 스트리밍 확정 지연 ~40% 감소 예상

### 1.3 Simul-Whisper (AlignAtt + Truncation Detection)

- **논문**: "Simul-Whisper: Attention-Guided Streaming Whisper with Truncation Detection" (Wang et al., 2024)
- **출처**: INTERSPEECH 2024 | [arXiv:2406.10052](https://arxiv.org/abs/2406.10052)
- **GitHub**: [backspacetg/simul_whisper](https://github.com/backspacetg/simul_whisper)

**핵심 아이디어**: AlignAtt로 cross-attention 최대값 위치를 추적해 디코딩 중단점 결정. Integrate-and-Fire 기반 truncation detection으로 청크 경계 잘린 단어 문제 해결. 1초 청크에서 WER 열화 평균 1.46%만 발생.

- **적용 가능성**: **상** (현재 프로젝트가 이미 AlignAtt 사용, truncation detection 추가만 필요)
- **구체적 적용 방안**: `whisper.cpp`의 AlignAtt 디코딩 루프에 IF 뉴런 기반 truncation detector 추가. 잘린 단어 감지 시 다음 청크로 컨텍스트 이월.
- **예상 효과**: 청크 경계 WER 1-2% 개선, 부분 단어 오인식 감소

### 1.4 CarelessWhisper (Causal Streaming)

- **논문**: "CarelessWhisper: Turning Whisper into a Causal Streaming Model" (Krichli et al., 2025)
- **출처**: [arXiv:2508.12301](https://arxiv.org/abs/2508.12301)
- **GitHub**: [tomer9080/CarelessWhisper-streaming](https://github.com/tomer9080/CarelessWhisper-streaming)

**핵심 아이디어**: 비인과적 인코더를 LoRA 파인튜닝으로 인과적 인코더로 변환. 300ms 미만 청크에서 기존 비파인튜닝 스트리밍보다 우수. 약하게 정렬된 데이터셋으로 학습, 단어 수준 타임스탬프도 추출 가능.

- **적용 가능성**: 중 (LoRA 파인튜닝 필요, 커스텀 모델 배포 필요)
- **구체적 적용 방안**: medium 모델에 일본어 데이터 LoRA 파인튜닝 후 CoreML 변환 → 300ms 청크로 진정한 스트리밍 가능
- **예상 효과**: 지연 1.2s → 300ms 수준, 단 커스텀 모델 필요

### 1.5 Whisper Large-v3-Turbo

- **출처**: OpenAI, 2024.10 | [HuggingFace](https://huggingface.co/openai/whisper-large-v3-turbo)

**핵심 아이디어**: Large-v3에서 디코더 레이어 32→4개로 축소. 인코더는 Large-v3과 동일. Distil-Whisper에서 영감, 하지만 원본 데이터셋으로 재학습. 속도 대폭 향상, Large-v2 수준 정확도 유지.

- **적용 가능성**: **상** (whisper.cpp에서 이미 지원, 모델 교체만 필요)
- **구체적 적용 방안**: `medium-q5_0` → `large-v3-turbo-q5_0`로 모델 교체. 인코더 더 크지만 디코더가 8배 빨라 decode 시간 50-100ms → ~15-25ms 예상.
- **예상 효과**: 디코드 지연 60-75% 감소, 인코더 약간 증가. 번역 성능은 하락 가능 (번역 데이터 미포함)

### 1.6 Distil-Whisper

- **논문**: "Distil-Whisper: Robust Knowledge Distillation via Large-Scale Pseudo Labelling" (Gandhi et al., 2023)
- **출처**: [arXiv:2311.00430](https://arxiv.org/abs/2311.00430)
- **GitHub**: [huggingface/distil-whisper](https://github.com/huggingface/distil-whisper)
- **최신 버전**: distil-large-v3.5 (2025)

**핵심 아이디어**: 지식 증류로 6x 빠르고 49% 작으며 OOD에서 WER 1% 이내. 디코더 2레이어로 축소. distil-large-v3.5는 Large-v3-Turbo보다 1.5x 빠르면서 단문 정확도 우위.

- **적용 가능성**: 하 (**영어 전용**, 일본어 미지원)
- **구체적 적용 방안**: 영어 전용이므로 직접 적용 불가. 하지만 kotoba-whisper가 동일 방법론으로 일본어 지원 (아래 참조)
- **예상 효과**: N/A (언어 제약)

---

## 2. VAD 통합 최적화

### 2.1 Silero VAD v5

- **출처**: [GitHub - snakers4/silero-vad](https://github.com/snakers4/silero-vad)
- **최신**: v5 (2024)

**핵심 아이디어**: v4 대비 TorchScript 3x 빠름, ONNX 10% 빠름. 6000+ 언어 지원. 모델 2MB. 16kHz에서 512 샘플(32ms) 윈도우, 1ms 미만 처리. 8kHz도 지원.

- **적용 가능성**: **상** (현재 Silero VAD 사용 중, 파라미터 튜닝으로 즉시 효과)
- **구체적 적용 방안**:
  - `threshold`: 0.5 → 0.3-0.4로 낮춰 일본어 저에너지 발화 감지 개선
  - `min_speech_duration_ms`: 250ms → 150ms (짧은 상호작용에 대응)
  - `min_silence_duration_ms`: 현재값 → 300ms (구 경계 민감도 조절)
  - v5로 업그레이드 시 파라미터 재캘리브레이션 필수 (v4와 출력 분포 상이)
- **예상 효과**: VAD 반응 지연 50-100ms 감소, false negative 감소

### 2.2 WhisperX VAD Cut & Merge 전략

- **논문**: "WhisperX: Time-Accurate Speech Transcription of Long-Form Audio" (Bain et al., 2023)
- **출처**: INTERSPEECH 2023 | [arXiv:2303.00747](https://arxiv.org/abs/2303.00747)
- **GitHub**: [m-bain/whisperX](https://github.com/m-bain/whisperX)

**핵심 아이디어**: VAD로 오디오 세그먼트 후 최소 음성 활동 구간에서 cut & merge하여 ~30초 청크 생성. 배치 추론으로 12x 속도 향상. Forced alignment으로 단어 수준 타임스탬프.

- **적용 가능성**: 중 (배치 처리는 실시간에 부적합, cut & merge 전략은 참고 가능)
- **구체적 적용 방안**: VAD 경계에서 청크 분할 시 "최소 활동 구간"에서 분할하는 전략을 현재 스트리밍 파이프라인에 적용. 청크 경계가 단어 중간에 걸리는 것 방지.
- **예상 효과**: 청크 경계 WER 개선, 환각 유발 확률 감소

---

## 3. 환각(Hallucination) 방지

### 3.1 Lost in Transcription (분포 이동과 환각)

- **논문**: "Lost in Transcription, Found in Distribution Shift" (Barański et al., 2025)
- **출처**: ACL 2025 Findings | [arXiv:2502.12414](https://arxiv.org/abs/2502.12414)

**핵심 아이디어**: Hallucination Error Rate(HER) 메트릭 제안. 20개+ ASR 모델 분석. 분포 이동과 HER 강한 상관(α=0.91). 낮은 WER가 위험한 환각을 숨길 수 있음. SNR -4dB~-2dB에서 환각 20% 증가. Bag of Hallucinations(BoH) 기반 감지법 제안.

- **적용 가능성**: **상** (환각 감지 로직에 즉시 적용 가능)
- **구체적 적용 방안**:
  - BoH 패턴 목록을 일본어용으로 구축 (반복 구문, 의미 없는 구 등)
  - SNR 추정 → 저SNR 구간에서 환각 필터 threshold 강화
  - `no_speech_prob` + `compression_ratio` + `avg_logprob` 3중 필터 적용
- **예상 효과**: 환각 발생률 50-70% 감소 예상

### 3.2 Listen Like a Teacher (ALA + KD)

- **논문**: "Listen Like a Teacher: Mitigating Whisper Hallucinations using Adaptive Layer Attention and Knowledge Distillation" (Sony AI, 2025)
- **출처**: AAAI 2025 | [arXiv:2511.14219](https://arxiv.org/abs/2511.14219)

**핵심 아이디어**: 2단계 구조. (1) Adaptive Layer Attention: 인코더 레이어를 의미 블록으로 그룹화, 학습 가능한 multi-head attention으로 저/고수준 특성 융합. (2) Knowledge Distillation: 노이즈 오디오 학생 모델이 클린 오디오 교사 모델의 의미/어텐션 분포 정렬.

- **적용 가능성**: 하 (커스텀 학습 필요, whisper.cpp 직접 적용 어려움)
- **구체적 적용 방안**: 장기적으로 일본어 노이즈 데이터로 KD 학습한 커스텀 모델 생성 가능. 단기적으로는 개념만 참조 (노이즈 환경 감지 → 필터 강화).
- **예상 효과**: 노이즈 환경 WER 5-10% 개선 (커스텀 학습 시)

### 3.3 기존 Whisper 내장 필터링 최적화

- **출처**: [OpenAI Whisper Discussion #679](https://github.com/openai/whisper/discussions/679), [Discussion #2420](https://github.com/openai/whisper/discussions/2420)

**핵심 파라미터**:
| 파라미터 | 기본값 | 권장 조정 | 효과 |
|---------|--------|----------|------|
| `compression_ratio_threshold` | 2.4 | 1.8-2.0 | 반복 환각 조기 차단 |
| `logprob_threshold` | -1.0 | -0.8 | 불확실 세그먼트 필터 강화 |
| `no_speech_threshold` | 0.6 | 0.5 | 무음 구간 환각 차단 |
| `condition_on_previous_text` | true | false | 환각 루프 방지 |

- **적용 가능성**: **상** (whisper.cpp 파라미터 변경만으로 즉시 적용)
- **구체적 적용 방안**: `whisper_full_params`에서 위 값 조정. 특히 `condition_on_previous_text=false`는 반복 환각에 즉효.
- **예상 효과**: 반복 환각 70%+ 감소, 약간의 문맥 연속성 손실 트레이드오프

---

## 4. 모바일/엣지 디바이스 최적화

### 4.1 WhisperKit (Apple Silicon 최적 ASR)

- **논문**: "WhisperKit: On-device Real-time ASR with Billion-Scale Transformers" (Argmax, 2025)
- **출처**: ICML 2025 | [arXiv:2507.10860](https://arxiv.org/html/2507.10860v1)
- **GitHub**: [argmaxinc/WhisperKit](https://github.com/argmaxinc/WhisperKit)

**핵심 아이디어**: ANE 전용 Transformer 최적화. Stateful Models로 KV 캐시 in-place 업데이트 → Text Decoder 45% 지연 감소 (8.4ms→4.6ms, M3 ANE). 에너지 75% 절감 (1.5W→0.3W). Large-v3-Turbo로 WER 2.2%, 지연 0.46초 달성.

- **적용 가능성**: **상** (Swift 네이티브, Tauri+Swift 브릿지로 통합 가능)
- **구체적 적용 방안**:
  - whisper.cpp 대신 WhisperKit Swift 패키지로 교체
  - Stateful KV 캐시 → 디코더 반복 호출 시 45% 지연 절감
  - ANE 최적화 CoreML 모델 사용 (argmaxinc/whisperkit-coreml)
  - 스트리밍 모드: WhisperKit의 실시간 전사 API 활용
- **예상 효과**: 인코더+디코더 총 지연 150-250ms → 80-120ms, 에너지 75% 절감

### 4.2 Whisper 양자화 비교 분석

- **논문**: "Quantization for OpenAI's Whisper Models: A Comparative Analysis" (2025)
- **출처**: [arXiv:2503.09905](https://arxiv.org/abs/2503.09905)

**핵심 아이디어**: INT4/INT5/INT8 양자화 비교. INT8은 지연 19% 감소, 모델 45% 축소, 정확도 유지. INT4는 압축률 우수하나 노이즈 환경에서 강건성 하락. CPU에서 INT8이 최적 속도-정확도 균형.

- **적용 가능성**: **상** (현재 q5_0 사용 중, 양자화 레벨 조정 가능)
- **구체적 적용 방안**:
  - 현재 `medium-q5_0` → `large-v3-turbo-q5_0` 또는 `large-v3-turbo-q8_0` 비교 테스트
  - 인코더는 INT8 (정확도 민감), 디코더는 INT4 (속도 우선) 혼합 양자화 검토
  - whisper.cpp의 `--compute-type` 옵션으로 벤치마크
- **예상 효과**: q5→q8 전환 시 WER 0.2-0.5% 개선, 속도 약간 하락. 모델 크기는 1.5x 증가.

### 4.3 Speculative Decoding for Whisper

- **출처**: [HuggingFace Blog](https://huggingface.co/blog/whisper-speculative-decoding)

**핵심 아이디어**: 작은 assistant 모델(distil-whisper)로 빠르게 토큰 생성 후, 메인 모델로 검증. 수학적으로 동일한 출력 보장하면서 2x 속도. VRAM 8%만 추가.

- **적용 가능성**: 하 (whisper.cpp에 speculative decoding 미구현, Python/Transformers 전용)
- **구체적 적용 방안**: 장기적으로 whisper.cpp에 speculative decoding 포팅 가능. 단기적으로는 Whisper-Medusa 방식이 더 실용적.
- **예상 효과**: 디코딩 2x 속도 (구현 시)

### 4.4 Whisper-Medusa (Multi-Token Prediction)

- **논문**: "Whisper in Medusa's Ear: Multi-head Efficient Decoding" (aiOla, 2024)
- **출처**: [arXiv:2409.15869](https://arxiv.org/abs/2409.15869)
- **GitHub**: [aiola-lab/whisper-medusa](https://github.com/aiola-lab/whisper-medusa)

**핵심 아이디어**: Medusa 헤드 추가로 1회 추론에 10개 토큰 동시 예측. Medusa-Block 구조로 WER 유지하면서 지연 20-68% 감소. 메인 Whisper 가중치 동결 상태로 추가 파라미터만 학습.

- **적용 가능성**: 중 (커스텀 모델 필요, 하지만 구조 변경이 비교적 단순)
- **구체적 적용 방안**: Large-v3-Turbo에 Medusa 헤드 추가 학습 → CoreML 변환. 디코더 호출 횟수 ~50% 감소.
- **예상 효과**: 디코드 시간 50-68% 추가 감소

---

## 5. 최신 대안 아키텍처

### 5.1 Moonshine (Edge-First ASR)

- **논문**: "Flavors of Moonshine: Tiny Specialized ASR Models for Edge Devices" (Moonshine AI, 2025)
- **출처**: [arXiv:2509.02523](https://arxiv.org/html/2509.02523v1)
- **GitHub**: [moonshine-ai/moonshine](https://github.com/moonshine-ai/moonshine)

**핵심 아이디어**: 가변 길이 처리로 제로패딩 제거 → Whisper 대비 5x~35x 빠름. Tiny 모델(27M) 이 Whisper Medium(28x 큼)과 동등 성능. ONNX Runtime 기반 C++ 코어, 크로스플랫폼. sub-200ms 지연.

- **적용 가능성**: **상** (ONNX 기반으로 macOS 네이티브 통합 가능)
- **구체적 적용 방안**:
  - Moonshine Base (English) 또는 Tiny-Ko (한국어) ONNX 모델 테스트
  - 일본어 지원 여부 확인 필요 (현재 6개 언어 Tiny 모델)
  - whisper.cpp 대체 또는 빠른 프리스크리닝용 보조 모델로 활용
  - ONNX Runtime for macOS + CoreML EP로 ANE 가속 가능
- **예상 효과**: 지연 200ms 이하 달성 가능 (일본어 모델 존재 시)

### 5.2 SenseVoice (Alibaba FunAudioLLM)

- **출처**: [GitHub - FunAudioLLM/SenseVoice](https://github.com/FunAudioLLM/SenseVoice) | [HuggingFace](https://huggingface.co/FunAudioLLM/SenseVoiceSmall)

**핵심 아이디어**: 비자기회귀 E2E 아키텍처. Whisper-small 대비 7x, Whisper-large 대비 17x 빠름. 인식 지연 80ms 미만. 중/영/광동어/일본어/한국어 5개 언어. 감정 인식 + 오디오 이벤트 감지 동시 지원.

- **적용 가능성**: **상** (일본어 네이티브 지원, 극도로 낮은 지연)
- **구체적 적용 방안**:
  - SenseVoice-Small ONNX 모델 macOS 배포 테스트
  - 비자기회귀 → 디코딩 루프 없음 → 지연 근본적 감소
  - Whisper와 병행 사용: SenseVoice로 빠른 1차 인식 → Whisper로 정제
  - 감정 인식 기능을 자막에 메타데이터로 추가 가능
- **예상 효과**: 인식 지연 80ms 이하, 일본어 WER Whisper 대비 20%+ 개선 가능

### 5.3 NVIDIA Canary (NeMo)

- **출처**: [HuggingFace - nvidia/canary-1b-v2](https://huggingface.co/nvidia/canary-1b-v2) | [NVIDIA Blog](https://developer.nvidia.com/blog/new-standard-for-speech-recognition-and-translation-from-the-nvidia-nemo-canary-model/)

**핵심 아이디어**: FastConformer Encoder + Transformer Decoder. 1B 파라미터. HuggingFace Open ASR Leaderboard 1위 (WER 6.67%). 25개 EU 언어 + 스트리밍 지원. 청크 기반 스트리밍 디코딩.

- **적용 가능성**: 하 (NVIDIA GPU 최적화, macOS/ANE 지원 없음)
- **구체적 적용 방안**: macOS에서 직접 사용 어려움. 서버 사이드 하이브리드 구성 시만 가능.
- **예상 효과**: N/A (하드웨어 불일치)

### 5.4 Kotoba-Whisper (일본어 특화 Distil-Whisper)

- **출처**: [HuggingFace - kotoba-tech/kotoba-whisper-v2.0](https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0)
- **GitHub**: [kotoba-tech/kotoba-whisper](https://github.com/kotoba-tech/kotoba-whisper)

**핵심 아이디어**: Large-v3를 교사 모델로 한 일본어 특화 지식 증류. 디코더 2레이어. ReazonSpeech 데이터셋(7.2M 클립) 학습. Large-v3 대비 6.3x 빠르면서 동등 CER/WER.

- **적용 가능성**: **상** (일본어 특화, Distil-Whisper 구조로 whisper.cpp 호환)
- **구체적 적용 방안**:
  - kotoba-whisper-v2.0 → GGUF 변환 → whisper.cpp에서 로드
  - 디코더 2레이어로 디코드 시간 대폭 감소
  - ReazonSpeech 학습으로 일본어 자연어 인식 최적화
  - CoreML 변환으로 ANE 가속 가능
- **예상 효과**: 일본어 인식 속도 6x 향상, CER 동등 또는 개선, 디코드 지연 ~10-15ms

---

## 6. 추가 참고 기술

### 6.1 whisper.cpp CoreML/Metal 최적화 현황

- **출처**: [GitHub - ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp)

**현황 정리**:
- CoreML: 인코더 ANE 가속 시 CPU 대비 3-6x 빠름. 첫 실행 시 컴파일 지연(~4분), 이후 캐시됨.
- Metal: 디코더 GPU 가속 자동 활성화.
- Large-v3-turbo + CoreML: 평균 1.23초 (5분 오디오 기준)
- Stateful KV 캐시: WhisperKit만 지원, whisper.cpp는 미지원

### 6.2 whisper.cpp Apple Silicon 벤치마크

| 모델 | M1 | M2 | M3 | M4 |
|------|-----|-----|-----|-----|
| medium (CPU) | ~2.5x RT | ~2.0x RT | ~1.5x RT | ~1.2x RT |
| medium + CoreML | ~0.8x RT | ~0.6x RT | ~0.5x RT | ~0.4x RT |
| large-v3-turbo + CoreML | ~1.0x RT | ~0.8x RT | ~0.6x RT | ~0.5x RT |

> RT = Real-Time factor (1.0 = 실시간, 낮을수록 빠름)

---

## TOP 5 추천 개선안 (우선순위)

### 🥇 1순위: WhisperKit 또는 Kotoba-Whisper로 런타임 교체

**이유**: 현재 아키텍처의 근본적 한계를 돌파하는 가장 효과적인 방법

| 옵션 | 장점 | 단점 | 예상 지연 |
|------|------|------|----------|
| **WhisperKit** (Swift) | ANE 최적화, Stateful KV 캐시, 45% 디코더 가속, 에너지 75%↓ | whisper.cpp 전체 교체 필요 | **80-120ms** |
| **Kotoba-Whisper** (GGUF) | 일본어 특화, 6.3x 빠름, whisper.cpp 호환 | 일본어 전용, 모델 변환 필요 | **100-150ms** |

**구체적 실행 계획**:
1. kotoba-whisper-v2.0 → GGUF 변환 후 whisper.cpp에서 즉시 테스트 (1-2일)
2. WhisperKit Swift 패키지를 Tauri Swift 브릿지에 통합 PoC (3-5일)
3. 두 옵션 벤치마크 비교 후 선택

---

### 🥈 2순위: SenseVoice-Small 병행 도입 (80ms 이하 초저지연)

**이유**: 비자기회귀 아키텍처로 300ms 목표를 즉시 달성 가능

**구체적 실행 계획**:
1. SenseVoice-Small ONNX 모델 macOS 빌드 테스트 (1-2일)
2. ONNX Runtime + CoreML EP로 ANE 가속 확인
3. 기존 Whisper 파이프라인과 병행: SenseVoice → 즉시 표시, Whisper → 정제 결과 덮어쓰기
4. 일본어 인식 품질 벤치마크 (ReazonSpeech 테스트셋)

**예상 효과**: 체감 지연 80ms 이하, 일본어 WER 20%+ 개선

---

### 🥉 3순위: 환각 방지 3중 필터 강화

**이유**: 즉시 적용 가능, 코드 변경 최소

**구체적 실행 계획**:
1. `compression_ratio_threshold`: 2.4 → 1.8
2. `logprob_threshold`: -1.0 → -0.8
3. `no_speech_threshold`: 0.6 → 0.5
4. 일본어 BoH(Bag of Hallucinations) 패턴 구축:
   - 반복 구문: `ご視聴ありがとうございました`, `チャンネル登録`, `お願いします` 등
   - 무의미 반복: 동일 토큰 3회+ 연속
5. SNR 추정 → 저SNR 구간에서 threshold 동적 강화
6. Simul-Whisper truncation detection 추가

**예상 효과**: 환각 50-70% 감소, 구현 시간 1-2일

---

### 4순위: Large-v3-Turbo 모델 업그레이드

**이유**: 모델 파일 교체만으로 디코더 8배 가속

**구체적 실행 계획**:
1. `large-v3-turbo` GGUF + CoreML 모델 다운로드
2. 기존 `medium-q5_0` 대비 벤치마크: 속도, WER, 메모리
3. CoreML 모델 첫 실행 컴파일 시간 확인 (앱 시작 시 UX 영향)
4. 인코더 크기 증가분 vs 디코더 감소분 순효과 확인

**예상 효과**: 디코드 50-100ms → 15-25ms, 인코더 100-150ms → 120-180ms (약간 증가), 총 지연 약간 감소. 일본어 번역 성능은 별도 검증 필요.

---

### 5순위: Silero VAD v5 파라미터 최적화

**이유**: 파이프라인 시작점 최적화로 전체 반응성 개선

**구체적 실행 계획**:
1. Silero VAD v5로 업그레이드 (v4 → v5, ONNX 모델 교체)
2. 일본어 음성 데이터로 최적 threshold 탐색 (0.3-0.5 범위)
3. `min_speech_duration_ms` 150ms, `min_silence_duration_ms` 300ms 테스트
4. VAD 출력을 AlignAtt 청크 경계와 동기화

**예상 효과**: VAD 반응 50-100ms 개선, 전체 파이프라인 시작 지연 감소

---

## 참고 문헌 전체 목록

1. Macháček et al., "Turning Whisper into Real-Time Transcription System", INTERSPEECH 2023 — [arXiv](https://arxiv.org/abs/2307.14743)
2. Macháček & Polák, "Simultaneous Translation with Offline Speech and LLM Models", IWSLT 2025 — [GitHub](https://github.com/ufal/SimulStreaming)
3. Wang et al., "Simul-Whisper: Attention-Guided Streaming Whisper with Truncation Detection", INTERSPEECH 2024 — [arXiv](https://arxiv.org/abs/2406.10052)
4. Krichli et al., "CarelessWhisper: Turning Whisper into a Causal Streaming Model", 2025 — [arXiv](https://arxiv.org/abs/2508.12301)
5. Gandhi et al., "Distil-Whisper: Robust Knowledge Distillation via Large-Scale Pseudo Labelling", 2023 — [arXiv](https://arxiv.org/abs/2311.00430)
6. Bain et al., "WhisperX: Time-Accurate Speech Transcription of Long-Form Audio", INTERSPEECH 2023 — [arXiv](https://arxiv.org/abs/2303.00747)
7. Barański et al., "Lost in Transcription, Found in Distribution Shift", ACL 2025 — [arXiv](https://arxiv.org/abs/2502.12414)
8. Sony AI, "Listen Like a Teacher: Mitigating Whisper Hallucinations", AAAI 2025 — [arXiv](https://arxiv.org/abs/2511.14219)
9. Argmax, "WhisperKit: On-device Real-time ASR with Billion-Scale Transformers", ICML 2025 — [arXiv](https://arxiv.org/html/2507.10860v1)
10. "Quantization for OpenAI's Whisper Models: A Comparative Analysis", 2025 — [arXiv](https://arxiv.org/abs/2503.09905)
11. aiOla, "Whisper in Medusa's Ear: Multi-head Efficient Decoding", 2024 — [arXiv](https://arxiv.org/abs/2409.15869)
12. Moonshine AI, "Flavors of Moonshine: Tiny Specialized ASR Models for Edge Devices", 2025 — [arXiv](https://arxiv.org/html/2509.02523v1)
13. Alibaba, "FunAudioLLM: Voice Understanding and Generation Foundation Models", 2024 — [arXiv](https://arxiv.org/html/2407.04051v1)
14. Kotoba Technologies, "kotoba-whisper-v2.0" — [HuggingFace](https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0)
15. Silero VAD v5 — [GitHub](https://github.com/snakers4/silero-vad)
16. OpenAI, "whisper-large-v3-turbo" — [HuggingFace](https://huggingface.co/openai/whisper-large-v3-turbo)
17. NVIDIA, "Canary-1B-v2" — [HuggingFace](https://huggingface.co/nvidia/canary-1b-v2)
18. HuggingFace, "Speculative Decoding for 2x Faster Whisper Inference" — [Blog](https://huggingface.co/blog/whisper-speculative-decoding)
