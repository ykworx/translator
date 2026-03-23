# Lightning-SimulWhisper vs Transrator 비교 검증 보고서

> 작성일: 2026-03-22
> 대상: [altalt-org/Lightning-SimulWhisper](https://github.com/altalt-org/Lightning-SimulWhisper)

---

## 1. Lightning-SimulWhisper 프로젝트 개요

### 1.1 프로젝트 배경

Lightning-SimulWhisper는 [SimulStreaming](https://github.com/ufal/SimulStreaming) (Charles University, IWSLT 2025 동시 음성 번역 1위 시스템)의 **MLX/CoreML 포팅**이다.

- **원본**: SimulStreaming — PyTorch 기반, GPU(CUDA) 타겟, 10GB+ VRAM 필요
- **Lightning 포팅**: Apple Silicon 전용, CoreML 인코더 + MLX 디코더 하이브리드
- **목적**: Alt 앱의 실시간 로컬 전사 엔진 (macOS)
- **저장소 통계**: 523 stars, 42 forks, 71 commits, MIT License

### 1.2 핵심 아키텍처

```
Audio (16kHz mono)
  → Mel Spectrogram (MLX)
  → CoreML Encoder (ANE, ~271ms for medium)
  → MLX Decoder (AlignAtt policy, greedy/beam search)
  → Text Output (streaming partial results)
```

**핵심 차별점:**
1. **CoreML 인코더**: whisper.cpp의 CoreML 모델(.mlpackage)을 직접 로드 → ANE 가속
2. **MLX 디코더**: Apple MLX 프레임워크로 디코딩 — AlignAtt 정책, beam search, 스트리밍 가능
3. **하이브리드 설계**: 인코더(CoreML/ANE) + 디코더(MLX/GPU) 분리로 전력/성능 최적화

### 1.3 AlignAtt 동작 원리

[Simul-Whisper 논문](https://arxiv.org/html/2406.10052v1) (2024)에서 제안된 기법:

1. **크로스 어텐션 기반 위치 추적**: 디코딩 중 가장 높은 어텐션이 위치한 프레임(`most_attended_frame`)을 추적
2. **안전 중단 조건**: `content_mel_len - most_attended_frame ≤ frame_threshold` 이면 디코딩 중단
   - 스트리밍: `frame_threshold=25` (약 0.5초 여유)
   - 파이널라이즈: `frame_threshold=4` (거의 끝까지 디코딩)
3. **Rewind 감지**: 어텐션이 과거로 돌아가면 디코딩 중단 + 재시작
4. **30초 윈도우 관리**: 오디오 초과 시 가장 오래된 세그먼트 제거, 컨텍스트 토큰으로 이전

**장점**: Whisper 모델 수정/파인튜닝 없이 스트리밍 가능 (1초 청크에서 WER 1.46% 저하만 발생)

### 1.4 지원 모델 및 언어

- **모델**: tiny, base, small, medium, large-v1/v2/v3, large-v3-turbo
- **언어**: Whisper 지원 99개 언어 (일본어 포함)
- **기본 설정**: language="zh" (중국어), 일본어("ja")로 변경 가능

### 1.5 성능 벤치마크 (공식 발표)

| 항목 | MLX Only | CoreML + MLX |
|------|----------|-------------|
| 인코더 (medium, M2) | ~800-1000ms | **~271ms** |
| 인코더 speedup | 1x | **~3-5x** (vs MLX) |
| 전력 소비 | ~15-20W | **~5-8W** |
| 팬 소음 | 활성 | **무소음** |

CoreML 인코더 모델별 수치:
- base.en: ~150ms
- small: ~200ms
- **medium: ~271ms**
- large-v3: ~400ms

---

## 2. 비교표: Transrator vs Lightning-SimulWhisper

| 항목 | Transrator (현재) | Lightning-SimulWhisper |
|------|-------------------|----------------------|
| **언어** | Swift/C++ (whisper.cpp) | Python (MLX + CoreML) |
| **아키텍처** | whisper.cpp + CoreML (통합) | CoreML 인코더 + MLX 디코더 (하이브리드) |
| **스트리밍 방식** | AlignAtt (C 구현, whisper.cpp 내장) | AlignAtt (Python, SimulStreaming 포팅) |
| **인코더** | whisper.cpp CoreML ANE (~530ms) | CoreML ANE (~271ms) |
| **디코더** | whisper.cpp ggml Metal (~11ms) | MLX (~?ms, beam search 포함) |
| **VAD** | Silero ggml + CoreML VAD (듀얼) | Silero ONNX (torchaudio 의존) |
| **첫 토큰 지연** | ~1137ms | ~400-600ms (추정) |
| **RTF** | 0.107x | 미공개 (실시간 medium 가능 주장) |
| **일본어 지원** | O (medium 모델) | O (99개 언어 지원) |
| **Apple Silicon** | O (ANE + Metal, 네이티브) | O (CoreML + MLX, Python) |
| **환각 방지** | 패턴 + 3중 필터 (Set/Substr/Regex) | 미구현 (no_speech_prob 체크만) |
| **오프라인 동작** | O (완전 로컬) | O (완전 로컬) |
| **최소 청크 크기** | 0.6s (9,600 samples) | 1.0s (segment_length 기본값) |
| **최대 윈도우** | 30s (480,000 samples) | 30s (audio_max_len) |
| **프롬프트 캐리오버** | O (50 토큰) | O (max_context_tokens) |
| **오디오 캐리오버** | O (2초) | O (세그먼트 기반) |
| **번들 크기** | ~0 (네이티브 바이너리) | Python + MLX + torch + librosa (~수GB) |
| **메모리 사용** | 낮음 (ggml 양자화) | 높음 (Python + MLX + numpy) |
| **프로세스 모델** | 인프로세스 (Tauri 앱 내) | 별도 Python 프로세스 |

---

## 3. 핵심 차이 분석

### 3.1 인코더 성능 격차: 530ms vs 271ms

**Transrator의 인코더가 2배 느린 이유:**

Transrator는 whisper.cpp의 통합 CoreML 파이프라인을 사용한다. whisper.cpp는:
1. 항상 **30초 전체 mel spectrogram** (3000 프레임)을 CoreML에 전달
2. 짧은 오디오도 zero-padding으로 30초로 확장 → **불필요한 연산**
3. 인코더 출력 1500 프레임 중 실제 의미 있는 부분은 일부

Lightning-SimulWhisper도 30초 패딩은 동일하지만, CoreML 인코더 호출 자체가 더 효율적이다:
- whisper.cpp의 CoreML 래퍼는 C++ ↔ Objective-C ↔ CoreML 브릿지 오버헤드가 있음
- Lightning-SimulWhisper는 Python → CoreML 직접 호출 (coremltools)
- 모델 컴파일 최적화: `CPU_AND_NE` 옵션으로 Neural Engine 전용 실행

**결론**: 인코더 성능 차이는 **CoreML 호출 방식과 컴파일 최적화** 차이이며, 아키텍처적 한계가 아니다.

### 3.2 디코더 아키텍처 차이

| | Transrator | Lightning-SimulWhisper |
|---|---|---|
| 런타임 | ggml (C, Metal GPU) | MLX (Python, Metal GPU) |
| AlignAtt | C 레벨 구현 (whisper.cpp 수정) | Python 레벨 구현 |
| Beam Search | 미지원 (greedy만) | 지원 (beam_size=5) |
| 속도 | ~11ms/디코드 | 미공개 (MLX ~15x vs PyTorch) |

Transrator의 ggml 디코더는 이미 매우 빠르다(~11ms). MLX 디코더가 이보다 빠를 가능성은 낮다.

### 3.3 VAD 구현 차이

Transrator:
- **Silero ggml**: 512 samples (32ms) 해상도, CPU 최적화
- **CoreML VAD**: 4096 samples (256ms) 해상도, ANE 가속 (~0.3ms)
- 히스테리시스 (speech 0.5, neg 0.35), 적응형 침묵 임계값

Lightning-SimulWhisper:
- Silero ONNX (torchaudio 의존)
- `vad_silence_ms=500ms` 기본값
- VAD 구현 미완성 (`"VAD not implemented"` 주석)

**Transrator의 VAD가 더 성숙**하다. CoreML VAD + ggml Silero 듀얼 시스템은 Lightning-SimulWhisper에 없는 차별점.

### 3.4 환각 방지

Transrator는 3중 필터 시스템:
1. O(1) exact-match Set (한/영/일/중 패턴)
2. substring 검색
3. 컴파일된 정규식 (bracket 패턴)

Lightning-SimulWhisper는 `no_speech_prob` 체크만 (기본 threshold=1.0, 사실상 비활성).

---

## 4. 적용 가능성 분석

### 4.1 전면 교체 가능성: ❌ 비추천

| 요소 | 평가 |
|------|------|
| 언어 호환성 | Python ↔ Tauri(Rust/Swift) 통합 불가 |
| 번들 크기 | Python + MLX + torch 수GB → 데스크톱 앱에 부적합 |
| 메모리 사용 | Python 프로세스 오버헤드 |
| 기능 완성도 | VAD 미완성, 환각 필터 없음 |
| 유지보수 | 외부 Python 프로세스 관리 필요 |

### 4.2 부분 기법 차용: ✅ 적극 추천

#### 기법 A: CoreML 인코더 호출 최적화 (🔴 HIGH IMPACT)

**현재 문제**: whisper.cpp의 CoreML 인코더가 ~530ms (93% 병목)
**Lightning-SimulWhisper 수치**: 같은 medium 모델, 같은 CoreML → ~271ms

**차용 방안:**
1. whisper.cpp의 CoreML 브릿지 코드 프로파일링
2. `CPU_AND_NE` compute units 강제 설정 (현재 기본값 확인 필요)
3. CoreML 모델 컴파일 캐시 확인 (`.mlmodelc` 사전 컴파일)
4. C++ ↔ Obj-C 브릿지 오버헤드 최소화

**예상 효과**: 530ms → 270-350ms (40-50% 감소)
**구현 난이도**: 중 (whisper.cpp CoreML 래퍼 수정)
**예상 소요**: 2-3일

#### 기법 B: 적응형 frame_threshold (🟡 MEDIUM IMPACT)

**현재**: `alignAttFrameThreshold = 25` (고정)
**Lightning-SimulWhisper**: `frame_threshold=4` (기본), `rewind_threshold=200`

더 공격적인 threshold로 디코딩 조기 종료:
- 짧은 발화: threshold=4 (빠른 응답)
- 긴 발화: threshold=15-25 (안정적)

**예상 효과**: 디코딩 지연 20-30% 감소
**구현 난이도**: 하 (파라미터 조정)
**예상 소요**: 0.5일

#### 기법 C: Rewind 감지 도입 (🟡 MEDIUM IMPACT)

Lightning-SimulWhisper의 rewind 감지 로직:
- `last_attend_frame - most_attended_frame > rewind_threshold` → 디코딩 중단 + 재시작
- 어텐션이 과거로 돌아갈 때 (환각 징후) 조기 중단

**현재 Transrator에 없는 기능**으로, 환각 방지에 보완 효과.

**예상 효과**: 환각 빈도 감소 + 비정상 디코딩 시간 단축
**구현 난이도**: 중 (whisper.cpp C 레벨 수정)
**예상 소요**: 1-2일

#### 기법 D: CIF 모델 (단어 경계 감지) (🟢 LOW IMPACT, 향후)

Lightning-SimulWhisper는 CIF (Continuous Integrate-and-Fire) 모델로 단어 경계를 감지한다.
- 별도 뉴럴 모델 필요 (학습 데이터: LibriSpeech 100h)
- 영어 중심, 일본어 효과 미검증
- 현재 우선순위 낮음

### 4.3 whisper.cpp 호환성

| 항목 | 호환 여부 |
|------|----------|
| CoreML 모델 형식 | ✅ 동일 (.mlpackage, whisper.cpp 생성) |
| ggml 모델 형식 | ✅ 동일 (같은 Whisper 가중치) |
| AlignAtt 정책 | ✅ Transrator에 이미 C 구현 있음 |
| MLX 디코더 | ❌ 비호환 (Python 전용) |

**핵심**: Lightning-SimulWhisper의 CoreML 인코더 모델은 whisper.cpp와 **동일한 모델 파일**을 사용한다. 호환성 문제 없음.

---

## 5. 벤치마크 계획

### 5.1 Lightning-SimulWhisper 로컬 실행

```bash
# 환경 구축
git clone https://github.com/altalt-org/Lightning-SimulWhisper
cd Lightning-SimulWhisper
pip install -r requirements.txt
pip install coremltools ane_transformers

# CoreML 인코더 생성 (whisper.cpp 서브모듈 필요)
./scripts/generate_coreml_encoder.sh medium

# 실행 (일본어, medium 모델)
python3 simulstreaming_whisper.py test.wav \
  --model_name medium --model_path mlx_medium \
  --use_coreml --language ja
```

**실행 가능 여부**: ✅ Python 환경만 있으면 M-시리즈 Mac에서 즉시 실행 가능

### 5.2 동일 조건 비교 방법

**샘플 데이터**: ReazonSpeech 일본어 테스트 세트 (5-10초 발화 10개)

| 측정 항목 | Transrator | Lightning-SimulWhisper |
|-----------|-----------|----------------------|
| 인코더 시간 (ms) | whisper_stream_encode | TIMING_LOG_CSV |
| 디코더 시간 (ms) | whisper_stream_decode_alignatt | TIMING_LOG_CSV |
| 첫 토큰 지연 (ms) | PerformanceTracker | time.time() |
| 전체 RTF | end-to-end | end-to-end |
| WER (%) | 수동 비교 | 수동 비교 |
| 전력 (W) | powermetrics | powermetrics |

### 5.3 실행 단계

1. ReazonSpeech에서 일본어 WAV 파일 10개 다운로드
2. Transrator: `benchmark.rs` + `PerformanceTracker`로 측정
3. Lightning-SimulWhisper: `--language ja --use_coreml` 로 동일 파일 처리
4. 각 단계별 시간 비교 + WER 비교

---

## 6. 결론 및 추천

### 6.1 핵심 발견

1. **Lightning-SimulWhisper의 인코더는 같은 CoreML 모델로 2배 빠르다** (271ms vs 530ms)
   - 이는 모델 차이가 아닌 **호출 방식/최적화 차이**
   - whisper.cpp의 CoreML 브릿지 최적화로 해결 가능

2. **Transrator의 디코더와 VAD는 이미 더 우수하다**
   - ggml 디코더 ~11ms (매우 빠름)
   - CoreML VAD + Silero ggml 듀얼 (Lightning-SimulWhisper에 없음)
   - 3중 환각 필터 (Lightning-SimulWhisper에 없음)

3. **전면 교체는 비실용적**
   - Python 의존성 (수GB), 프로세스 관리, 번들 크기 문제
   - Transrator의 네이티브 Swift/C++ 아키텍처가 데스크톱 앱에 적합

### 6.2 300ms 목표 달성 로드맵

현재: 인코더 530ms + 디코더 11ms + 기타 = **~1137ms 첫 토큰**

| 단계 | 기법 | 예상 효과 | 소요 |
|------|------|----------|------|
| 1 | CoreML compute units 최적화 (`CPU_AND_NE`) | 530→400ms | 0.5일 |
| 2 | CoreML 브릿지 오버헤드 프로파일 + 최적화 | 400→300ms | 2일 |
| 3 | frame_threshold 적응화 (4↔25) | 디코더 20-30% 감소 | 0.5일 |
| 4 | Rewind 감지 도입 | 환각 시 빠른 복구 | 1일 |

**예상 결과**: 인코더 270-350ms + 디코더 ~11ms = **첫 토큰 ~350-450ms**

300ms 인코더 목표 달성은 CoreML 브릿지 최적화가 핵심이며, Lightning-SimulWhisper가 같은 모델로 271ms를 달성한 것이 **증거**다.

### 6.3 리스크 및 트레이드오프

| 리스크 | 영향 | 완화 방안 |
|--------|------|----------|
| whisper.cpp CoreML 래퍼 수정 복잡성 | 중 | 상위 프로젝트 이슈/PR 참조 |
| compute units 변경 시 정확도 변화 | 하 | WER 벤치마크로 검증 |
| 공격적 frame_threshold의 품질 저하 | 중 | 적응형 임계값으로 대응 |
| Lightning-SimulWhisper 벤치마크 재현 불가 | 하 | 로컬 실행으로 직접 검증 |

### 6.4 최종 추천

> **Lightning-SimulWhisper를 전면 도입하지 말고, CoreML 인코더 호출 최적화 기법을 차용하라.**
>
> 같은 CoreML 모델로 271ms를 달성한 것은 whisper.cpp CoreML 래퍼에 개선 여지가 있음을 증명한다.
> 1순위: `CPU_AND_NE` compute units 설정 확인 및 CoreML 브릿지 프로파일링
> 2순위: 적응형 AlignAtt frame_threshold + rewind 감지
>
> 이 조합으로 **인코더 300ms 미만 + 첫 토큰 400ms 미만** 목표 달성이 현실적이다.

---

## 참고 자료

- [Lightning-SimulWhisper GitHub](https://github.com/altalt-org/Lightning-SimulWhisper)
- [SimulStreaming (원본)](https://github.com/ufal/SimulStreaming)
- [Simul-Whisper 논문](https://arxiv.org/html/2406.10052v1)
- [Hacker News 토론](https://news.ycombinator.com/item?id=45620534)
- [whisper.cpp CoreML 토론](https://github.com/ggml-org/whisper.cpp/discussions/548)
- [WhisperKit 논문 (Apple Silicon ASR 비교)](https://arxiv.org/html/2507.10860v1)
