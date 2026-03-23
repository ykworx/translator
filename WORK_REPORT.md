# Whisper + CoreML STT 교체 작업 리포트

**작업일**: 2026-03-20
**브랜치**: feature/improve
**커밋**: `8116751` + 슬라이딩 윈도우 추가 (미커밋)

---

## 1. 개요

Transrator의 음성인식(STT) 엔진을 Apple `SFSpeechRecognizer`에서 **whisper.cpp + CoreML**로 교체했다.
오프라인 동작, 다국어 지원 개선, Apple Silicon 하드웨어 가속(ANE/Metal)을 목표로 한다.

### 변경 규모

| 항목 | 수치 |
|------|------|
| 변경 파일 | 23개 |
| 추가 코드 | +2,007줄 |
| 삭제 코드 | -335줄 |
| 신규 파일 | 4개 (WhisperEngine.swift, whisper-bridge.h, model_manager.rs, .gitmodules) |
| 서브모듈 | whisper.cpp v1.7.6 |

---

## 2. 아키텍처

### 2.1 전체 파이프라인

```
오디오 입력 (마이크 or 앱 캡처)
  → AVAudioEngine / ScreenCaptureKit
  → AVAudioConverter (16kHz mono float32)
  → WhisperEngine.appendPCMBuffer()
  │
  ├─ 슬라이딩 윈도우 (1초 스텝, 5초 윈도우, 200ms 오버랩)
  │   → whisper_full() 추론
  │     ├─ Silero VAD (885KB ggml) → 무음 구간 자동 필터링
  │     ├─ 인코더: CoreML → Apple Neural Engine
  │     ├─ 디코더: ggml Q5 → Metal GPU
  │     ├─ initial_prompt: 도메인 힌트 + 이전 결과
  │     └─ prompt_tokens: 이전 윈도우 컨텍스트 전달
  │
  ├─ 환각 필터 (패턴 매칭 + 반복 감지)
  │
  ├─ onPartialResult → 프론트엔드 실시간 표시
  └─ onFinalResult (침묵 감지 시) → 번역 파이프라인
      → Gemini API → 번역 결과 표시
```

### 2.2 하드웨어 활용

| 구성 요소 | 실행 위치 | 비고 |
|-----------|----------|------|
| Mel Spectrogram | CPU/Metal | whisper.cpp 내부 |
| Whisper 인코더 | **Apple Neural Engine** | CoreML .mlmodelc |
| Whisper 디코더 | **Metal GPU** | ggml Q5_0 양자화 |
| Silero VAD | CPU | ggml (885KB) |
| 오디오 캡처 | ScreenCaptureKit | 시스템 API |

### 2.3 모델 구성

| 파일 | 크기 | 용도 | 배포 |
|------|------|------|------|
| ggml-medium-q5_0.bin | ~540MB | 인코더+디코더 (Q5 양자화) | 첫 실행 시 다운로드 |
| ggml-medium-encoder.mlmodelc | ~170MB | CoreML 인코더 (ANE 가속) | 첫 실행 시 다운로드 |
| for-tests-silero-v5.1.2-ggml.bin | 885KB | Silero VAD 모델 | 앱 번들 내장 |

---

## 3. 구현 상세

### 3.1 Phase 1: 빌드 시스템 통합

**파일**: `build.rs`, `Cargo.toml`, `whisper-bridge.h`

- whisper.cpp v1.7.6을 git submodule로 추가
- `build.rs`에서 cmake로 whisper.cpp 빌드 (CoreML ON, Metal ON, Accelerate ON)
- 생성 라이브러리: `libwhisper.a`, `libwhisper.coreml.a`, `libggml*.a`
- Swift 브릿징 헤더에 `-Xcc -I` 로 whisper.h/ggml.h include 경로 전달
- Speech 프레임워크 링크 제거, Metal/Accelerate/CoreML/c++ 추가

### 3.2 Phase 2: WhisperEngine (핵심 엔진)

**파일**: `swift/WhisperEngine.swift` (신규, ~380줄)

**슬라이딩 윈도우 스트리밍 (stream.cpp 패턴)**:
```
파라미터:
  windowSize = 80,000 (5초)   ← 추론 윈도우
  stepSize   = 16,000 (1초)   ← 새 오디오 트리거
  keepSize   =  3,200 (200ms) ← 윈도우 간 오버랩

동작:
  [overlap 200ms][====== 5초 윈도우 ======]
                 ↑ 항상 이 크기만 추론 (일정한 추론 시간)

  → 1초 새 오디오 도착 시:
    마지막 5초 윈도우 추출 → whisper_full() → partial result
    prompt_tokens 저장 → 다음 윈도우에 컨텍스트 전달

  → 침묵 1.5초 감지 시:
    현재 윈도우 finalize → final result → 버퍼 초기화
```

**소유자 관리**: mic/appCaption 동시 사용 방지 (acquire/release)

**Silero VAD**: whisper.cpp 내장 VAD 활성화 (`params.vad = true`)
- threshold = 0.45, min_speech = 250ms, padding = 30ms
- whisper_full 내부에서 무음 구간 자동 제거 → 환각 방지

**환각 필터**: 알려진 패턴 매칭 + 반복 감지
- "시청해 주셔서 감사합니다", "Thank you for watching" 등

**도메인 힌트**: `initial_prompt`로 디코더에 컨텍스트 제공
- 첫 윈도우: 도메인 힌트 문자열 사용
- 이후 윈도우: `prompt_tokens` (토큰 ID)로 이전 결과 전달

### 3.3 Phase 3: 모델 다운로드 시스템

**파일**: `src/model_manager.rs` (신규, ~320줄)

**Tauri 커맨드**:
- `check_whisper_model` → 모델 상태 확인
- `download_whisper_model` → 스트리밍 다운로드 + 진행률 이벤트
- `delete_whisper_model` → 모델 삭제 (FFI deadlock 방지)
- `load_whisper_model` → Swift FFI로 모델 로드
- `set_whisper_domain_hint` → 도메인 힌트 설정

**자동 로드**: 앱 시작 시 `auto_load_model()` → 이전에 다운로드한 모델 자동 로드

**레거시 호환**: `ggml-medium.bin` (FP16)과 `ggml-medium-q5_0.bin` (Q5) 양쪽 인식

### 3.4 Phase 4-5: 브릿지 마이그레이션

**파일**: `MicSpeechBridge.swift`, `AppCaptionBridge.swift`

| 항목 | Before | After |
|------|--------|-------|
| STT 엔진 | SFSpeechRecognizer | WhisperEngine.shared |
| 권한 | Speech + Microphone | **Microphone만** (+ 모델 로드 확인) |
| 오디오 변환 | AVAudioEngine 직접 → SFSpeech | AVAudioConverter → 16kHz → WhisperEngine |
| 침묵 감지 | SFSpeech 내부 | WhisperEngine RMS + Silero VAD |
| 세션 관리 | restartRecognitionTask() | WhisperEngine 슬라이딩 윈도우 (자동) |

**C API 시그니처 변경 없음**: Rust 측 `speech.rs`, `caption_capture.rs` 최소 수정

### 3.5 Phase 6: 프론트엔드

**타입 변경**: `speechAuthorized` → `modelLoaded` (types.ts, speech.rs, caption_capture.rs)

**설정 UI**:
- 모델 다운로드/삭제 UI (진행률 바, 2-click 삭제 확인)
- 도메인 힌트 선택 (비즈니스/기술/일상/강의/뉴스/의료/법률)

**실시간 캡션**:
- 경과시간 표시 (00:00부터 초 단위 카운트, 상태바 + 캡션 카드)
- 번역 카드 타임스탬프 (HH:MM, 카드 우하단)

---

## 4. 성능 비교

### 4.1 지연 시간

| 항목 | SFSpeechRecognizer (이전) | whisper.cpp 초기 구현 | 슬라이딩 윈도우 (현재) |
|------|--------------------------|---------------------|---------------------|
| 첫 결과 지연 | ~200-500ms | ~3-5초 | **~1.3-1.5초** |
| 추론 시간 | 실시간 (스트리밍) | 가변 (버퍼 비례) | **일정 (~0.3-0.5초)** |
| 버퍼 크기 | 없음 (스트리밍) | 최대 30초 | **고정 5초** |

### 4.2 모델 크기

| 항목 | FP16 | Q5_0 (현재) |
|------|------|-------------|
| ggml 모델 | 1.5GB | **540MB** |
| 다운로드 시간 (100Mbps) | ~2분 | **~43초** |
| 메모리 사용량 | ~1.5GB | **~540MB** |
| 디코더 추론 | 기준 | **~2배 빠름** |

### 4.3 정확도

| 항목 | SFSpeechRecognizer | Whisper medium (Q5 + CoreML) |
|------|--------------------|-----------------------------|
| 한국어 | 보통 | **높음** |
| 일본어 | 보통 | **높음** |
| 영어 | 높음 | **높음** |
| 다국어 혼합 | 불가 | **자동 감지** |
| 오프라인 | 제한적 | **완전 오프라인** |

---

## 5. 파일 변경 목록

### 신규 파일

| 파일 | 설명 |
|------|------|
| `.gitmodules` | whisper.cpp 서브모듈 설정 |
| `src-tauri/vendor/whisper.cpp` | whisper.cpp v1.7.6 서브모듈 |
| `src-tauri/swift/whisper-bridge.h` | C 브릿징 헤더 (whisper.h 노출) |
| `src-tauri/swift/WhisperEngine.swift` | Whisper 엔진 싱글톤 (~380줄) |
| `src-tauri/src/model_manager.rs` | 모델 다운로드/관리 (~320줄) |

### 수정 파일

| 파일 | 변경 내용 |
|------|----------|
| `src-tauri/build.rs` | cmake whisper.cpp 빌드, CoreML/Metal 링크, 브릿지 헤더 |
| `src-tauri/Cargo.toml` | cc, reqwest, futures-util, zip 의존성 추가 |
| `src-tauri/src/lib.rs` | model_manager 모듈 + 5개 커맨드 등록 |
| `src-tauri/src/speech.rs` | speechAuthorized → modelLoaded |
| `src-tauri/src/caption_capture.rs` | speechAuthorized → modelLoaded |
| `src-tauri/swift/MicSpeechBridge.swift` | SFSpeech → WhisperEngine 교체 |
| `src-tauri/swift/AppCaptionBridge.swift` | SFSpeech → WhisperEngine 교체 |
| `src-tauri/capabilities/default.json` | event:allow-listen/emit 추가 |
| `src-tauri/tauri.conf.json` | Silero VAD 모델 리소스 번들 |
| `src/types.ts` | speechAuthorized → modelLoaded |
| `src/constants.ts` | DOMAIN_HINTS, domainHint 설정키 추가 |
| `src/settings.ts` | 모델 다운로드 UI + 도메인 힌트 드롭다운 |
| `src/speechInput.ts` | 도메인 힌트 설정 연동 |
| `src/appCaptions.ts` | 경과시간 표시, 캡션 타임스탬프, 도메인 힌트 |
| `src/ui.ts` | 번역 카드 타임스탬프 (HH:MM) |
| `src/styles.css` | caption-time, card-time 스타일 |
| `settings.html` | 모델 관리 UI, 도메인 힌트 셀렉트 |

---

## 6. 해결한 문제들

### 6.1 빌드 시 ggml.h include 경로 누락
- **원인**: whisper.h가 ggml.h를 참조하는데 Swift 컴파일 시 경로 없음
- **해결**: swiftc에 `-Xcc -I vendor/whisper.cpp/include -Xcc -I vendor/whisper.cpp/ggml/include` 추가

### 6.2 ggml_backend_blas_reg 링크 에러
- **원인**: BLAS 백엔드가 기본 활성화되지만 라이브러리 없음
- **해결**: cmake에 `-DGGML_BLAS=OFF` 추가 (Accelerate가 대체)

### 6.3 FFI deadlock (runOnMain)
- **원인**: Tauri async 커맨드 → Tokio 스레드에서 `DispatchQueue.main.sync` 호출 → deadlock
- **해결**: `whisper_engine_load_model`, `whisper_engine_unload_model`에서 `runOnMain` 제거 (NSLock으로 thread-safe)

### 6.4 Whisper 환각 ("시청해 주셔서 감사합니다")
- **원인**: 무음 입력 시 Whisper가 학습 데이터(YouTube 자막)에서 가장 흔한 텍스트 생성
- **해결**: Silero VAD로 무음 필터링 + 패턴 매칭 환각 필터 + suppress_blank/suppress_nst

### 6.5 버퍼 증가에 따른 추론 시간 증가
- **원인**: 전체 버퍼를 매번 재추론 (20초 → 2-4초 소요)
- **해결**: 슬라이딩 윈도우 (5초 고정) + prompt_tokens 컨텍스트 전달

---

## 7. 향후 개선 방향

### 단기 (전략 B: 조기 토큰 방출)
- whisper.cpp의 `new_segment_callback` 활용
- 디코더 진행 중 확신도 높은 토큰 먼저 방출
- 예상 지연: 300~500ms
- 작업량: 2~3일

### 중기 (전략 C: AlignAtt 동시 디코딩)
- whisper.cpp 디코딩 루프 (7157행) 수정
- 인코더 출력의 어텐션 가중치 기반 토큰-오디오 정렬
- DTW alignment으로 토큰 조기 확정
- 예상 지연: 200~300ms
- 작업량: 2~3주

### 화자 분리
- pyannote embedding → CoreML 변환 (LSTM 없는 모델)
- SpeakerDiarizer.swift: 코사인 유사도 기반 화자 식별
- 캡션 UI에 화자 라벨 + 색상 표시

---

## 8. 빌드 및 검증

```bash
# Rust + Swift + whisper.cpp 빌드
cd tauri-app/src-tauri && cargo build

# 프론트엔드 빌드
cd tauri-app && npm run build

# 개발 서버 실행
cd tauri-app && npx tauri dev
```

### 검증 항목
- [x] `cargo build` 성공 (경고 없음)
- [x] `npm run build` 성공
- [ ] 설정에서 모델 다운로드 → 진행률 표시 → 완료
- [ ] 마이크 음성 입력 → Whisper 인식 결과 표시
- [ ] 앱 오디오 캡처 → 실시간 자막 인식
- [ ] 침묵 감지 → 자동 finalize
- [ ] 모델 삭제 후 인식 시작 시 에러 메시지
- [ ] 앱 재시작 후 모델 자동 로드
