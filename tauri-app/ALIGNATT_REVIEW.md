# AlignAtt 구현 검토 보고서

## 참조 구현: [Lightning-SimulWhisper](https://github.com/altalt-org/Lightning-SimulWhisper)

---

## 1. 현재 상태 요약

whisper.cpp에 AlignAtt 스트리밍 디코딩 API를 추가하고, Swift(WhisperEngine)에서 호출하는 파이프라인을 구현한 상태.
빌드 성공, 오디오 입력→인코딩→디코딩 루프 동작 확인. 그러나 **실시간 텍스트 출력이 나오지 않는** 문제가 있음.

### 수정 파일

| 파일 | 변경 |
|---|---|
| `vendor/whisper.cpp/include/whisper.h` | +64줄. 6개 스트리밍 API 선언 |
| `vendor/whisper.cpp/src/whisper.cpp` | +477줄. stream state, init, append, encode, decode_impl, finalize, reset |
| `swift/WhisperEngine.swift` | +300줄 (net). InferenceMode, 버퍼링, streaming decode, finalize |
| `swift/whisper-bridge.h` | 변경 없음 (이미 whisper.h include) |

---

## 2. 참조 구현(Lightning-SimulWhisper) 알고리즘

출처: `simul_whisper/simul_whisper.py` (`PaddedAlignAttWhisper.infer()`)

```
① mel spectrogram 계산 (30초 zero-pad, content_mel_len 추적)
② encoder 실행 (전체 30초 패딩된 mel)
③ 토큰별 디코딩 루프:
   a. logits 계산 → 토큰 샘플링 (greedy/beam)
   b. cross-attention 추출 (alignment heads만)
   c. Z-score 정규화 (시퀀스 축)
   d. Median filter (width=7, 오디오 축)
   e. heads 평균 → 실제 오디오 범위로 clip
   f. argmax → most_attended_frame (마지막 토큰만)
   g. 판정:
      content_mel_len - most_attended_frame <= frame_threshold → STOP (마지막 토큰 제거)
      last_attend - most_attended > rewind_threshold(200) → ABORT (rewind 감지)
   h. 안전하면 → 토큰 확정, 다음 토큰으로
④ 디코드 종료 후: CIF 모델로 미완성 단어 잘라냄
```

### 핵심 매개변수

| 매개변수 | 참조 기본값 | 단위 | 의미 |
|---|---|---|---|
| `frame_threshold` | **25** | mel 프레임 (20ms/프레임) | 오디오 끝에서 500ms 이내 attention → STOP |
| `frame_threshold` (finalize) | **4** | mel 프레임 | 마지막 청크에서는 80ms까지 허용 |
| `rewind_threshold` | **200** | mel 프레임 (4초) | attention이 급격히 뒤로 점프하면 중단 |
| median filter width | **7** | 프레임 | 어텐션 노이즈 제거 |
| alignment heads | 모델별 고정 | - | whisper 논문의 alignment heads |

---

## 3. 우리 구현과의 차이 분석

### 3.1 frame_threshold — 치명적 차이

| | 참조 | 우리 |
|---|---|---|
| 값 | 25 mel프레임 = **500ms** | 4 encoder프레임 ≈ **160ms** |
| 단위 | mel 프레임 (1프레임 = 20ms) | encoder 프레임 (1프레임 ≈ 40ms) |

**영향**: 0.5초 오디오(~25 encoder 프레임)에서:
- 참조: `25 - f <= 12` → f ≥ 13이면 STOP → 13프레임 안전 구간
- 우리: `25 - f <= 4` → f ≥ 21이면 STOP → 21프레임 안전 구간

수치상으로는 우리가 더 관대하지만, **단위 환산이 다름**. 참조의 25 mel프레임 = 우리의 ~12 encoder프레임.

**수정**: `frame_threshold`를 **12**로 변경 (encoder 프레임 기준, ≈480ms).

### 3.2 어텐션 전처리 — 누락된 핵심 단계

참조 구현은 argmax 전에 **두 가지 전처리**를 수행:

#### Z-score 정규화 (시퀀스 축)
```python
mean = mx.mean(attn, axis=-2, keepdims=True)  # 시퀀스 축 평균
std = mx.sqrt(mx.var(attn, axis=-2, keepdims=True, ddof=0))
attn = (attn - mean) / std
```
- 목적: 각 오디오 프레임이 시퀀스 전체에서 얼마나 "튀는지" 정규화
- 효과: 어텐션 분포가 고르게 퍼져 있어도 상대적 피크를 찾을 수 있음

#### Median filter (width=7, 오디오 축)
```python
attn = median_filter(attn, 7)
```
- 목적: 단일 프레임 스파이크 노이즈 제거
- 효과: 인접 프레임들의 중앙값으로 smooth → argmax 안정화

**우리 구현**: 두 단계 모두 없음. raw attention에 직접 argmax → **노이즈에 취약, 불안정한 판정**.

**수정**: C++ 코드에 z-score 정규화와 median filter 추가.

### 3.3 어텐션 범위 클리핑

| | 참조 | 우리 |
|---|---|---|
| 방법 | `attn[:, :, :content_mel_len]` (슬라이싱) | `argmax(f < n_audio_frames)` (루프 범위 제한) |

기능적으로 동일. 다만:
- 참조는 content_mel_len이 **mel 프레임 단위** (예: 50 for 0.5s)
- 우리는 n_audio_frames가 **encoder 프레임 단위** (예: 25 for 0.5s)
- 어텐션 텐서 크기: 참조는 1500(encoder 출력), 우리도 1500

**의문점**: 참조에서 `content_mel_len`이 mel 프레임 단위(50)인데 어텐션이 1500 차원이면, `attn[:,:,:50]`은 첫 50개 encoder 프레임만 보는 것. 이는 첫 100 mel 프레임에 해당. content_mel_len=50일 때 실제 오디오는 50 mel프레임 = 25 encoder프레임인데, 50개를 취하면 2배 넓게 봄. **단위 혼동 가능성 있음** — 별도 확인 필요.

### 3.4 안전장치 비교

| 기능 | 참조 | 우리 |
|---|---|---|
| Rewind 감지 | `last - current > 200` → 중단 | **없음** |
| CIF 단어 경계 | 미완성 단어 잘라냄 | **없음** |
| attn_ratio 체크 | 없음 | `< 0.5` → STOP |

- **Rewind 감지**: 환각(hallucination) 시 어텐션이 갑자기 뒤로 점프하는 패턴 포착. 추가 권장.
- **CIF**: 별도 모델 필요, 현재 미구현. 우선순위 낮음.
- **attn_ratio**: 참조에 없는 우리만의 추가 체크. zero-pad 영역 어텐션 누수 감지용. 유지 권장.

### 3.5 디코딩 구조 — 동일

| | 참조 | 우리 |
|---|---|---|
| mel 패딩 | 30초 zero-pad | whisper.cpp 내부에서 동일 |
| encoder 실행 | 전체 mel | 전체 mel (`mel_offset=0`) |
| decoder 재실행 | 새 오디오마다 처음부터 | 새 오디오마다 `kv_self` clear + replay |
| 확정 토큰 | 프롬프트에 포함하여 replay | 동일 |
| 프롬프트 구성 | `[SOT, lang, task, not]` + prev | 동일 |
| 토큰 되돌리기 | STOP 시 마지막 토큰 제거 | `kv_cache_seq_rm` + 미추가 (동일 효과) |

---

## 4. Swift 측 발견된 버그

### 4.1 streamState nil 가드 순서 (수정 완료)

```swift
// 버그: streamState가 nil인 상태에서 ensureStreamInit() 도달 전에 return
guard let ctx, let ss = streamState else { return }  // ← nil이면 여기서 끝
guard ensureStreamInit() else { return }              // ← 여기까지 안 옴

// 수정: ensureStreamInit 먼저 호출 (내부에서 streamState 생성)
guard let ctx else { return }
guard ensureStreamInit() else { return }
guard let ss = streamState else { return }
```

### 4.2 finalize 무한 스팸 (수정 완료)

```
원인: streamTotalSent가 async 완료 전까지 리셋 안 됨
  → totalAccumulated = 704,000 >> 96,000 (max)
  → 매 20ms마다 finalizeStreaming() 호출
  → isInferenceRunning=true 반복 설정, async 큐에 finalize 적재

수정: isFinalizePending 플래그 추가 + streamTotalSent 즉시 리셋
```

### 4.3 오디오 드롭 (수정 완료)

```
원인: isInferenceRunning일 때 samples를 버퍼링하지 않고 버림
수정: streamPendingSamples에 항상 append, 드롭 없음
```

### 4.4 미수정 이슈

- **forceFinalize/release 경쟁**: `forceFinalize()`가 async인데 직후 `release()`가 콜백 nil화 → 최종 결과 유실 가능
- **이중 침묵 감지**: WhisperEngine 내부(700ms) + AppCaptionBridge(700ms/3s) 겹침 → 과도한 세그먼트 분리
- **partial 의미 불일치**: 콜백이 "이번 새 세그먼트 텍스트"를 보내는데, 브리지는 이를 전체 transcript로 덮어씀

---

## 5. 수정 우선순위

### P0 — 동작하지 않는 문제

| # | 항목 | 현재 | 수정 |
|---|---|---|---|
| 1 | frame_threshold 값 | 4 (encoder 프레임) | **12** (≈480ms, 참조의 25 mel프레임에 해당) |
| 2 | Z-score 정규화 | 없음 | 시퀀스 축 z-score 추가 |
| 3 | Median filter | 없음 | width=7 median filter 추가 |

### P1 — 안정성

| # | 항목 | 설명 |
|---|---|---|
| 4 | Rewind 감지 | `last_attend - current > 100` 이면 중단 (encoder 프레임 기준) |
| 5 | forceFinalize/release 경쟁 | release()에서 finalize 완료 대기 |
| 6 | 이중 침묵 감지 제거 | 스트리밍 모드에서 AppCaptionBridge 침묵 감지 비활성화 |

### P2 — 품질 향상

| # | 항목 | 설명 |
|---|---|---|
| 7 | partial 누적 텍스트 | 콜백에서 confirmed 전체 텍스트를 보내도록 통일 |
| 8 | 미완성 단어 잘라냄 | 마지막 공백 기준 truncation (CIF 없이) |
| 9 | aheads_cross_QKs 텐서 수명 검증 | ggml_free(ctx0) 후 포인터 유효성 확인 |

---

## 6. 참조 구현의 핵심 코드 (발췌)

### AlignAtt 판정 루프 (Python)

```python
# simul_whisper/simul_whisper.py — PaddedAlignAttWhisper.infer()

for i in range(max_tokens):
    logits = self.logits(current_tokens, audio_features)
    next_token = logits.argmax(axis=-1)
    current_tokens = mx.concatenate([current_tokens, next_token], axis=1)

    # 어텐션 추출 (alignment heads만)
    attn = mx.stack([self.dec_attns[layer][head] for layer, head in align_source])

    # Z-score 정규화
    mean = mx.mean(attn, axis=-2, keepdims=True)
    std = mx.sqrt(mx.var(attn, axis=-2, keepdims=True, ddof=0))
    attn = (attn - mean) / std

    # Median filter
    attn = median_filter(attn, 7)

    # Head 평균 + 실제 오디오 범위만
    attn = attn.mean(axis=1)[:, :, :content_mel_len]

    # Argmax (마지막 토큰)
    most_attended_frame = mx.argmax(attn[:, -1, :], axis=-1)[0].item()

    # 판정
    if content_mel_len - most_attended_frame <= frame_threshold:
        current_tokens = current_tokens[:, :-1]  # 마지막 토큰 제거
        break

    # Rewind 감지
    if self.last_attend_frame - most_attended_frame > rewind_threshold:
        # 현재 가설 폐기, 이전 상태로 복원
        break

    self.last_attend_frame = most_attended_frame
```

### 우리 구현의 대응 코드 (C++)

```cpp
// whisper.cpp — whisper_stream_decode_impl()

for (int i = 0; i < n_max; ++i) {
    auto token = whisper_sample_token(*ctx, decoder, true);
    if (token.id == whisper_token_eot(ctx)) break;

    // 토큰을 디코더에 피드 (save_alignment_heads_QKs=true)
    whisper_decode_internal(*ctx, *state, state->batch, n_threads, check_alignment, ...);

    if (check_alignment && state->aheads_cross_QKs != nullptr) {
        // 어텐션 읽기
        ggml_backend_tensor_get(state->aheads_cross_QKs, attn_data.data(), ...);

        // ❌ Z-score 정규화 없음
        // ❌ Median filter 없음

        // Head 평균 + 실제 오디오 범위만 argmax
        for (int f = 0; f < n_audio_frames; ++f) { ... }  // ← 범위 제한은 있음

        // 판정
        if (most_attended >= n_audio_frames - frame_threshold) {  // frame_threshold=4 ← 너무 작음
            whisper_kv_cache_seq_rm(kv_self, 0, n_past - 1, -1);
            break;
        }

        // ❌ Rewind 감지 없음
    }

    stream.confirmed.push_back(token);
}
```

---

## 7. 아키텍처 다이어그램

```
┌─────────── Lightning-SimulWhisper ────────────┐  ┌────────── 우리 구현 ──────────────┐
│                                                │  │                                    │
│  Audio → 30s pad → mel → encoder(full)         │  │  Audio → pcm_buffer → mel → encode │
│                                                │  │  (동일 구조)                         │
│  Decode loop:                                  │  │  Decode loop:                       │
│    sample token                                │  │    sample token                     │
│    extract cross-attn (alignment heads)        │  │    extract aheads_cross_QKs         │
│    ┌──────────────────────────────────┐        │  │    ┌──────────────────────────────┐ │
│    │ Z-score normalize               │ ← 없음  │  │    │ (없음)                        │ │
│    │ Median filter (w=7)             │ ← 없음  │  │    │ (없음)                        │ │
│    └──────────────────────────────────┘        │  │    └──────────────────────────────┘ │
│    mean over heads                             │  │    mean over heads                  │
│    clip to content_mel_len                     │  │    argmax in [0, n_audio_frames)    │
│    argmax → most_attended                      │  │    argmax → most_attended           │
│                                                │  │                                    │
│    threshold = 25 mel (500ms)     ← 3x 차이    │  │    threshold = 4 enc (160ms)        │
│    rewind check (200 frames)      ← 없음       │  │    attn_ratio check (우리만)         │
│    CIF word boundary              ← 없음       │  │                                    │
└────────────────────────────────────────────────┘  └────────────────────────────────────┘
```
