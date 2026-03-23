# Speaker Diarization 기술 조사 및 구현 방안 설계

**작성일**: 2026-03-22
**브랜치**: feature/improve
**목표**: 실시간 STT에 화자 분리(Speaker Diarization) 기능 추가

---

## 1. 기술 비교표

### 1.1 화자 분리 프레임워크/모델 비교

| 프레임워크 | 정확도 (DER) | 지연 | CoreML 호환 | 실시간 가능 | 오프라인 | 라이선스 | 비고 |
|-----------|-------------|------|------------|-----------|---------|---------|------|
| **FluidAudio** (CoreML) | 15-22% | 17ms RTF (60x RT) | **네이티브** | **O** (26% DER @5s) | **O** | MIT | **최적 후보** — ANE 가속, Swift SDK |
| **pyannote-audio 3.1** | 11-19% | ~25ms RTF (40x RT) | 변환 필요 | △ (diart) | O | MIT | SOTA 정확도, PyTorch 기반 |
| **pyannote-onnx** | ~17-20% | ONNX RT 의존 | ONNX→CoreML 가능 | △ | O | MIT | PyTorch 의존성 제거 |
| **sherpa-onnx** | ~20% | ONNX RT 기반 | ONNX→CoreML 가능 | O | **O** | Apache 2.0 | C++ 코어, Swift 브릿지 가능 |
| **diart** (실시간 pyannote) | ~21-29% | 500ms 윈도우 | X (Python) | **O** | O | MIT | 실시간 특화, Python 전용 |
| **Picovoice Falcon** | 비공개 | 낮음 | X (자체 바이너리) | O | **O** | 상용 | C API, AccessKey 필요 |
| **tinydiarize** (whisper.cpp) | ~PoC 수준 | 추론시 포함 | O (whisper.cpp) | O | **O** | MIT | 화자 변경 토큰, 실험적 |
| **WeSpeaker** | EER 0.5-1% | 경량 | ONNX→CoreML | 임베딩만 | O | Apache 2.0 | 화자 임베딩 전용 |
| **NVIDIA Streaming Sortformer** | SOTA 급 | 프레임 수준 | X (CUDA) | **O** | X | Apache 2.0 | GPU 전용, 참고용 |

### 1.2 화자 임베딩 모델 비교

| 모델 | 임베딩 차원 | 모델 크기 | EER (VoxCeleb1-O) | ONNX 지원 | CoreML 변환 | 비고 |
|------|-----------|----------|-------------------|----------|------------|------|
| **WeSpeaker ECAPA-TDNN (512)** | 512 | ~26MB | 0.67% | **O** | O | **추천** — 균형 잡힌 성능/크기 |
| **WeSpeaker ResNet34** | 256 | ~45MB | 0.56% | **O** | O | 최고 정확도, 더 큰 모델 |
| **SpeechBrain ECAPA-TDNN** | 192 | ~80MB | 0.80% | PyTorch→ONNX | △ | 동적 그래프 이슈 |
| **Resemblyzer (GE2E)** | 256 | ~17MB | ~5% | X | △ | 가볍지만 낮은 정확도 |
| **3D-Speaker CAM++** | 512 | ~30MB | 0.60% | O | O | Alibaba, Mandarin 특화 |
| **3D-Speaker ERes2Net** | 512 | ~50MB | 0.50% | O | O | 높은 정확도 |

---

## 2. 추천 아키텍처

### 2.1 결론: FluidAudio 기반 + 자체 온라인 클러스터링

**핵심 근거**:
1. **FluidAudio**는 pyannote segmentation + WeSpeaker 임베딩을 CoreML로 변환하여 ANE에서 실행
2. 60x 실시간 처리 속도 (M1 기준), CPU 사용 최소화
3. Swift 네이티브 SDK — 현재 프로젝트의 Swift 레이어와 자연스럽게 통합
4. MIT 라이선스, CocoaPods/SPM 지원
5. 오프라인 동작 완전 보장

**대안 경로** (FluidAudio 사용 불가 시):
- WeSpeaker ECAPA-TDNN ONNX → coremltools로 CoreML 변환
- pyannote segmentation 3.0 ONNX → CoreML 변환
- 자체 클러스터링 구현 (코사인 유사도 + 온라인 spectral clustering)

### 2.2 전체 아키텍처

```
오디오 입력 (16kHz mono float32)
  │
  ├─ WhisperEngine (기존) ──→ STT 텍스트
  │
  └─ SpeakerDiarizer (신규) ──→ 화자 라벨
      │
      ├─ ① VAD (기존 Silero VAD 재활용)
      │     └─ 음성 구간 감지 → 세그먼트 경계
      │
      ├─ ② 화자 세분화 (Speaker Segmentation)
      │     └─ FluidAudio segmentation CoreML 모델
      │     └─ 입력: 5-10초 오디오 청크
      │     └─ 출력: 프레임별 화자 활동 확률
      │
      ├─ ③ 화자 임베딩 추출 (Speaker Embedding)
      │     └─ FluidAudio WeSpeaker CoreML 모델
      │     └─ 입력: 화자별 음성 세그먼트
      │     └─ 출력: 512차원 임베딩 벡터
      │
      ├─ ④ 온라인 클러스터링 (Online Clustering)
      │     └─ 코사인 유사도 기반 점진적 클러스터 할당
      │     └─ 임계값: 0.7 (FluidAudio 권장)
      │     └─ 새 화자 감지 시 클러스터 생성
      │
      └─ ⑤ 화자 할당 (Speaker Assignment)
            └─ STT 세그먼트 × 화자 라벨 시간 정렬
            └─ 결과: { text, speakerId, startTime, endTime }
```

### 2.3 Whisper STT와의 통합 방식

**WhisperX 방식의 실시간 변형**:

```
기존 WhisperEngine 파이프라인:
  오디오 → Silero VAD → whisper_full() → onPartialResult/onFinalResult

화자 분리 추가 후:
  오디오 → [기존 경로] → WhisperEngine → { text, timestamps }
       └─ [병렬 경로] → SpeakerDiarizer → { speakerId, timeRange }
                                ↓
                        화자 할당 (시간 기반 매칭)
                                ↓
                        onDiarizedResult → { text, speakerId, startTime }
```

**핵심 설계 원칙**:
- WhisperEngine과 SpeakerDiarizer는 **독립적으로 병렬 실행**
- 동일한 오디오 스트림을 공유 (appendPCMBuffer에서 분기)
- 화자 할당은 타임스탬프 기반 후처리로 결합
- STT 지연에 영향 주지 않음 (화자 라벨은 비동기 업데이트)

---

## 3. CoreML 파이프라인 설계

### 3.1 모델 구성

| 모델 | 역할 | 입력 | 출력 | 실행 위치 | 크기 (예상) |
|------|------|------|------|----------|-----------|
| Segmentation (pyannote 3.0 CoreML) | 프레임별 화자 활동 감지 | 10초 오디오 (160,000 샘플) | [frames × max_speakers] 확률 | **ANE** | ~5MB |
| Embedding (WeSpeaker ECAPA CoreML) | 화자 임베딩 벡터 추출 | 화자 음성 세그먼트 | 512차원 벡터 | **ANE** | ~26MB |

### 3.2 처리 흐름도

```
[오디오 스트림 16kHz]
       │
       │ (5초마다 청크 수집)
       ▼
┌─────────────────────────────────┐
│  ① Segmentation Model (CoreML)  │ ← ANE 가속
│  입력: Float32[1, 1, 160000]    │
│  출력: Float32[1, 589, 3]       │   (589프레임 × 최대3화자)
│  소요: ~8ms (ANE)               │
└─────────┬───────────────────────┘
          │
          │ 화자 활동 구간 추출
          ▼
┌─────────────────────────────────┐
│  ② 화자별 오디오 세그먼트 분리    │
│  활성 화자의 음성 구간 crop       │
│  최소 0.5초 이상 세그먼트만 사용   │
└─────────┬───────────────────────┘
          │
          │ 각 화자 세그먼트
          ▼
┌─────────────────────────────────┐
│  ③ Embedding Model (CoreML)     │ ← ANE 가속
│  입력: Mel spectrogram           │
│  출력: Float32[512]              │
│  소요: ~3ms (ANE)               │
└─────────┬───────────────────────┘
          │
          │ 512차원 임베딩
          ▼
┌─────────────────────────────────┐
│  ④ Online Clustering            │ ← CPU (Accelerate vDSP)
│  코사인 유사도 계산              │
│  임계값: 0.7                     │
│  새 클러스터 or 기존 클러스터 할당 │
│  소요: <1ms                     │
└─────────┬───────────────────────┘
          │
          │ speakerId
          ▼
┌─────────────────────────────────┐
│  ⑤ Speaker Assignment           │ ← CPU
│  STT 타임스탬프와 화자 라벨 매칭   │
│  결과: (text, speakerId, time)   │
└─────────────────────────────────┘
```

### 3.3 CoreML 모델 변환 (FluidAudio 미사용 시)

FluidAudio를 사용하면 이미 CoreML로 변환된 모델이 제공되므로 직접 변환이 불필요하다.
자체 변환이 필요한 경우의 절차:

```python
# 1. pyannote segmentation → ONNX
import torch
from pyannote.audio import Model

model = Model.from_pretrained("pyannote/segmentation-3.0")
dummy_input = torch.randn(1, 1, 160000)
torch.onnx.export(model, dummy_input, "segmentation.onnx",
                  input_names=["audio"],
                  output_names=["output"],
                  dynamic_axes={"audio": {2: "samples"}})

# 2. ONNX → CoreML
import coremltools as ct

mlmodel = ct.converters.convert(
    "segmentation.onnx",
    compute_units=ct.ComputeUnit.ALL  # ANE 포함
)
mlmodel.save("SpeakerSegmentation.mlpackage")

# 3. WeSpeaker ECAPA-TDNN — 이미 ONNX 제공
# https://github.com/wenet-e2e/wespeaker/blob/master/docs/pretrained.md
import coremltools as ct

mlmodel = ct.converters.convert(
    "wespeaker_ecapa_tdnn.onnx",
    compute_units=ct.ComputeUnit.ALL
)
mlmodel.save("SpeakerEmbedding.mlpackage")
```

**주의사항**:
- pyannote 모델의 동적 그래프 (conditional statements) → CoreML 변환 시 고정 입력 크기 사용
- WeSpeaker ONNX는 static graph → 변환 용이
- coremltools 8.x 이상 사용 권장 (ANE 최적화 개선)

---

## 4. Swift 구현 스케치

### 4.1 SpeakerDiarizer.swift — 핵심 클래스

```swift
import Foundation
import CoreML
import Accelerate

// MARK: - Speaker Diarization Result

struct DiarizedSegment {
    let speakerId: Int          // 0-based speaker index
    let speakerLabel: String    // "Speaker 1", "Speaker 2", ...
    let startTime: Double       // seconds
    let endTime: Double         // seconds
    let text: String            // STT 텍스트 (할당 후)
}

struct SpeakerEmbedding {
    let id: Int
    var centroid: [Float]       // 512-dim average embedding
    var count: Int              // number of segments assigned
    let color: SpeakerColor     // UI 표시용 색상
}

enum SpeakerColor: Int, CaseIterable {
    case blue = 0, green, orange, purple, teal, pink, yellow, red

    var hex: String {
        switch self {
        case .blue:   return "#4A90D9"
        case .green:  return "#27AE60"
        case .orange: return "#E67E22"
        case .purple: return "#8E44AD"
        case .teal:   return "#16A085"
        case .pink:   return "#E91E63"
        case .yellow: return "#F39C12"
        case .red:    return "#E74C3C"
        }
    }
}

// MARK: - Speaker Diarizer

final class SpeakerDiarizer {
    static let shared = SpeakerDiarizer()

    private let lock = NSLock()
    private let diarizationQueue = DispatchQueue(
        label: "transrator.diarization",
        qos: .userInitiated
    )

    // MARK: - FluidAudio (Primary Path)
    // import FluidAudioSwift
    // private var diarizer: DiarizerManager?

    // MARK: - Self-hosted Models (Fallback Path)
    private var segmentationModel: MLModel?
    private var embeddingModel: MLModel?

    // MARK: - State
    private var isInitialized = false
    private var speakers: [SpeakerEmbedding] = []
    private var audioChunkBuffer: [Float] = []
    private let chunkDuration: Int = 80_000  // 5초 at 16kHz
    private let chunkStep: Int = 48_000      // 3초 스텝 (2초 오버랩)
    private let clusteringThreshold: Float = 0.7
    private let maxSpeakers = 8

    // MARK: - Callbacks
    var onSpeakerChange: ((Int, String) -> Void)?  // (speakerId, label)
    var onDiarizedResult: ((DiarizedSegment) -> Void)?

    // MARK: - Initialization

    func initialize() async throws {
        // Option A: FluidAudio (권장)
        // diarizer = DiarizerManager()
        // try await diarizer?.initialize()

        // Option B: 자체 CoreML 모델 로드
        // segmentationModel = try loadCoreMLModel("SpeakerSegmentation")
        // embeddingModel = try loadCoreMLModel("SpeakerEmbedding")

        lock.lock()
        isInitialized = true
        lock.unlock()
    }

    // MARK: - Audio Input (WhisperEngine에서 호출)

    /// WhisperEngine.appendPCMBuffer()에서 분기하여 호출
    func appendAudio(_ samples: [Float]) {
        lock.lock()
        audioChunkBuffer.append(contentsOf: samples)
        let bufferCount = audioChunkBuffer.count
        lock.unlock()

        // 5초 분량 모이면 diarization 실행
        if bufferCount >= chunkDuration {
            diarizationQueue.async { [weak self] in
                self?.processChunk()
            }
        }
    }

    // MARK: - Diarization Processing

    private func processChunk() {
        lock.lock()
        guard audioChunkBuffer.count >= chunkDuration else {
            lock.unlock()
            return
        }

        // 5초 청크 추출 (3초 스텝이므로 2초 오버랩 유지)
        let chunk = Array(audioChunkBuffer.prefix(chunkDuration))
        if audioChunkBuffer.count > chunkStep {
            audioChunkBuffer.removeFirst(chunkStep)
        } else {
            audioChunkBuffer.removeAll(keepingCapacity: true)
        }
        lock.unlock()

        // ① Segmentation: 프레임별 화자 활동 확률
        guard let segmentation = runSegmentation(chunk) else { return }

        // ② 활성 화자 구간 추출 + 임베딩
        let speakerSegments = extractSpeakerSegments(
            audio: chunk,
            segmentation: segmentation
        )

        for segment in speakerSegments {
            // ③ 화자 임베딩 추출
            guard let embedding = runEmbedding(segment.audio) else { continue }

            // ④ 온라인 클러스터링
            let speakerId = assignSpeaker(embedding: embedding)

            // ⑤ 콜백
            let label = speakers[speakerId].color
            DispatchQueue.main.async { [weak self] in
                self?.onSpeakerChange?(speakerId, "Speaker \(speakerId + 1)")
            }
        }
    }

    // MARK: - Segmentation (CoreML)

    private func runSegmentation(_ audio: [Float]) -> [[Float]]? {
        // CoreML segmentation 모델 추론
        // 입력: [1, 1, 80000] (5초)
        // 출력: [frames, max_speakers] 확률 행렬

        // FluidAudio 사용 시:
        // let result = try await diarizer?.segment(audio, sampleRate: 16000)
        // return result?.frameProbabilities

        // 자체 CoreML 사용 시:
        // guard let model = segmentationModel else { return nil }
        // let input = try MLMultiArray(shape: [1, 1, NSNumber(value: audio.count)], dataType: .float32)
        // ... CoreML inference ...

        return nil // placeholder
    }

    // MARK: - Embedding (CoreML)

    private func runEmbedding(_ audio: [Float]) -> [Float]? {
        // CoreML 화자 임베딩 추출
        // 입력: 화자 음성 세그먼트
        // 출력: 512차원 벡터

        // FluidAudio 사용 시:
        // return try await diarizer?.extractEmbedding(audio, sampleRate: 16000)

        return nil // placeholder
    }

    // MARK: - Online Clustering (Accelerate vDSP)

    /// 코사인 유사도 기반 점진적 클러스터 할당
    func assignSpeaker(embedding: [Float]) -> Int {
        lock.lock()
        defer { lock.unlock() }

        if speakers.isEmpty {
            // 첫 화자
            let speaker = SpeakerEmbedding(
                id: 0,
                centroid: embedding,
                count: 1,
                color: SpeakerColor.allCases[0]
            )
            speakers.append(speaker)
            return 0
        }

        // 기존 화자들과 코사인 유사도 계산
        var bestSimilarity: Float = -1
        var bestIdx = -1

        for (idx, speaker) in speakers.enumerated() {
            let similarity = cosineSimilarity(embedding, speaker.centroid)
            if similarity > bestSimilarity {
                bestSimilarity = similarity
                bestIdx = idx
            }
        }

        if bestSimilarity >= clusteringThreshold {
            // 기존 화자에 할당 — centroid 업데이트 (이동 평균)
            let count = Float(speakers[bestIdx].count)
            let newCount = count + 1
            for i in 0..<embedding.count {
                speakers[bestIdx].centroid[i] =
                    (speakers[bestIdx].centroid[i] * count + embedding[i]) / newCount
            }
            speakers[bestIdx].count += 1
            return bestIdx
        } else if speakers.count < maxSpeakers {
            // 새 화자
            let newId = speakers.count
            let color = SpeakerColor.allCases[newId % SpeakerColor.allCases.count]
            let speaker = SpeakerEmbedding(
                id: newId,
                centroid: embedding,
                count: 1,
                color: color
            )
            speakers.append(speaker)
            return newId
        } else {
            // 최대 화자 수 초과 — 가장 유사한 화자에 할당
            return bestIdx
        }
    }

    /// vDSP 가속 코사인 유사도
    private func cosineSimilarity(_ a: [Float], _ b: [Float]) -> Float {
        var dotProduct: Float = 0
        var normA: Float = 0
        var normB: Float = 0
        let count = vDSP_Length(min(a.count, b.count))

        vDSP_dotpr(a, 1, b, 1, &dotProduct, count)
        vDSP_dotpr(a, 1, a, 1, &normA, count)
        vDSP_dotpr(b, 1, b, 1, &normB, count)

        let denom = sqrt(normA) * sqrt(normB)
        guard denom > 0 else { return 0 }
        return dotProduct / denom
    }

    // MARK: - Speaker-Text Assignment

    /// STT 결과에 화자 라벨 할당 (타임스탬프 기반)
    func assignSpeakerToText(
        text: String,
        startTime: Double,
        endTime: Double,
        currentSpeakerId: Int
    ) -> DiarizedSegment {
        let speaker = lock.withLock {
            speakers.indices.contains(currentSpeakerId)
                ? speakers[currentSpeakerId]
                : nil
        }

        return DiarizedSegment(
            speakerId: currentSpeakerId,
            speakerLabel: "Speaker \(currentSpeakerId + 1)",
            startTime: startTime,
            endTime: endTime,
            text: text
        )
    }

    // MARK: - Reset

    func reset() {
        lock.lock()
        speakers.removeAll()
        audioChunkBuffer.removeAll(keepingCapacity: true)
        lock.unlock()
    }
}
```

### 4.2 WhisperEngine 통합 변경점

```swift
// WhisperEngine.swift에 추가할 변경사항

// 1. appendPCMBuffer()에서 SpeakerDiarizer로 오디오 분기
func appendPCMBuffer(_ buffer: AVAudioPCMBuffer) {
    guard let floatData = buffer.floatChannelData?[0] else { return }
    let samples = Array(UnsafeBufferPointer(
        start: floatData,
        count: Int(buffer.frameLength)
    ))

    // 기존: STT 파이프라인
    processForSTT(samples)

    // 신규: 화자 분리 파이프라인 (병렬)
    if SpeakerDiarizer.shared.isEnabled {
        SpeakerDiarizer.shared.appendAudio(samples)
    }
}

// 2. onFinalResult 콜백 확장
// 기존: onFinalResult?(text)
// 변경: onDiarizedFinalResult?(text, speakerId)

// 3. 화자 변경 시 partial result에 화자 정보 포함
// onPartialResult?(text) → onPartialResult?(text, currentSpeakerId)
```

### 4.3 C API 확장 (Rust ↔ Swift)

```swift
// SpeakerDiarizer에 대한 C API

@_cdecl("diarizer_initialize")
public func diarizer_initialize() -> Bool {
    // SpeakerDiarizer.shared.initialize() 호출
    // 모델 로드 성공 여부 반환
    return true
}

@_cdecl("diarizer_get_current_speaker")
public func diarizer_get_current_speaker() -> Int32 {
    // 현재 활성 화자 ID 반환
    return Int32(SpeakerDiarizer.shared.currentSpeakerId)
}

@_cdecl("diarizer_get_speaker_info")
public func diarizer_get_speaker_info() -> UnsafeMutablePointer<CChar>? {
    // JSON으로 화자 정보 반환:
    // { "speakers": [{ "id": 0, "label": "Speaker 1", "color": "#4A90D9" }] }
    return nil // placeholder
}

@_cdecl("diarizer_reset")
public func diarizer_reset() {
    SpeakerDiarizer.shared.reset()
}
```

---

## 5. UI 변경사항

### 5.1 프론트엔드 화자 표시 방안

#### 실시간 캡션 화면

```
┌─────────────────────────────────────────┐
│  🎙 Recording  00:15  [Speaker 1]       │  ← 상태바에 현재 화자
│─────────────────────────────────────────│
│                                         │
│  ■ Speaker 1                            │  ← 화자 라벨 (컬러 인디케이터)
│  안녕하세요, 오늘 회의를 시작하겠습니다.     │
│                                         │
│  ■ Speaker 2                            │  ← 화자 변경 시 새 블록
│  네, 준비됐습니다.                        │
│                                         │
│  ■ Speaker 1                            │
│  첫 번째 안건은...                        │  ← 현재 발화 (진행중)
│                                         │
└─────────────────────────────────────────┘
```

#### 번역 카드 (화자 포함)

```
┌─────────────────────────────────────────┐
│  ■ Speaker 1               14:30        │
│  원문: 안녕하세요, 오늘 회의를 시작하겠습니다.│
│  번역: Hello, let's start today's meeting.│
├─────────────────────────────────────────┤
│  ■ Speaker 2               14:30        │
│  원문: 네, 준비됐습니다.                   │
│  번역: Yes, I'm ready.                   │
└─────────────────────────────────────────┘
```

### 5.2 TypeScript 타입 변경

```typescript
// types.ts 확장

interface SpeakerInfo {
  id: number;
  label: string;     // "Speaker 1", "Speaker 2", ...
  color: string;     // hex color "#4A90D9"
}

interface DiarizedResult {
  text: string;
  speakerId: number;
  speakerLabel: string;
  speakerColor: string;
  startTime: number;   // seconds
  endTime: number;
  isFinal: boolean;
}

// 기존 SpeechState 확장
interface SpeechState {
  transcript: string;
  isRunning: boolean;
  isFinal: boolean;
  // 신규
  currentSpeakerId?: number;
  speakers?: SpeakerInfo[];
}
```

### 5.3 CSS 변경

```css
/* 화자별 색상 인디케이터 */
.speaker-indicator {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
}

.speaker-label {
  font-size: 11px;
  font-weight: 600;
  opacity: 0.8;
  margin-bottom: 2px;
}

/* 화자 변경 시 구분선 */
.speaker-change {
  border-top: 1px solid var(--border);
  margin-top: 8px;
  padding-top: 8px;
}

/* 현재 활성 화자 하이라이트 */
.speaker-active {
  border-left: 3px solid var(--speaker-color);
  padding-left: 8px;
}
```

### 5.4 설정 UI

```
┌─ 화자 분리 설정 ──────────────────────┐
│                                       │
│  화자 분리  [토글 ON/OFF]              │
│                                       │
│  최대 화자 수  [드롭다운: 2/3/4/8]      │
│                                       │
│  민감도      [슬라이더: 낮음 ←──→ 높음] │
│  (클러스터링 임계값 0.5~0.9)            │
│                                       │
│  화자 라벨 초기화  [버튼]               │
│  (새 세션 시 화자 재할당)               │
│                                       │
└───────────────────────────────────────┘
```

---

## 6. 구현 로드맵

### Phase 1: MVP (2-3주)

**목표**: 기본 화자 분리 동작 확인

| 작업 | 설명 | 예상 기간 |
|------|------|----------|
| FluidAudio 통합 | SPM/CocoaPods로 FluidAudio 추가, 빌드 검증 | 2일 |
| SpeakerDiarizer.swift | 기본 구조, FluidAudio API 래핑 | 3일 |
| 오디오 분기 | WhisperEngine에서 SpeakerDiarizer로 오디오 전달 | 1일 |
| 오프라인 diarization | 녹음 완료 후 배치 처리 방식으로 화자 분리 | 2일 |
| C API + Rust 연동 | diarizer_* FFI 함수, Tauri 커맨드 | 2일 |
| 기본 UI | 화자 라벨 + 색상 표시 (캡션 영역) | 2일|
| 테스트 | 2-3인 대화 녹음으로 기본 동작 확인 | 2일 |

**산출물**:
- 녹음 → STT + 화자 라벨이 함께 표시
- 2-4명 화자 구분 가능
- 오프라인 배치 방식 (segment 완료 후 화자 할당)

### Phase 2: 실시간 최적화 (2-3주)

**목표**: 스트리밍 화자 분리, 낮은 지연

| 작업 | 설명 | 예상 기간 |
|------|------|----------|
| 스트리밍 diarization | FluidAudio streaming 모드 (5초 청크, 26% DER) | 3일 |
| VAD 재활용 | 기존 Silero VAD 결과를 diarization에 전달 | 2일 |
| 온라인 클러스터링 최적화 | Accelerate vDSP 코사인 유사도 + 이동 평균 centroid | 2일 |
| 화자 할당 파이프라인 | 실시간 STT 세그먼트에 화자 라벨 즉시 부여 | 2일 |
| UI 실시간 업데이트 | 화자 변경 시 즉시 라벨/색상 전환 | 2일 |
| 성능 프로파일링 | ANE/CPU 사용량 측정, 병목 제거 | 2일 |

**산출물**:
- 실시간 화자 라벨 (~5초 지연)
- ANE 가속으로 CPU 영향 최소화
- 기존 STT 지연에 추가 지연 없음

### Phase 3: 고급 기능 (3-4주)

**목표**: 정확도 향상 + 사용자 경험 개선

| 작업 | 설명 | 예상 기간 |
|------|------|----------|
| 화자 프로필 저장 | 알려진 화자 임베딩 저장/로드 (Tauri Store) | 3일 |
| 화자 이름 편집 | UI에서 "Speaker 1" → "김철수" 이름 변경 | 2일 |
| 화자 병합/분리 | 잘못 분리된 화자를 수동 병합/분리 | 3일 |
| 회의록 내보내기 | 타임스탬프 + 화자 + 텍스트를 Markdown/텍스트로 내보내기 | 2일 |
| 화자 임베딩 모델 업그레이드 | WeSpeaker ResNet34 또는 3D-Speaker ERes2Net 적용 | 3일|
| 앱 오디오 캡처 통합 | AppCaptionBridge.swift에도 화자 분리 적용 | 2일|
| 다국어 벤치마크 | 한/일/영 혼합 대화에서 정확도 측정 | 3일 |

**산출물**:
- 화자 프로필 관리 (저장/로드/이름)
- 회의록 내보내기
- 앱 오디오에서도 화자 분리
- DER < 25% (실시간), < 20% (오프라인)

---

## 부록 A: 핵심 참고 자료

- [FluidAudio — CoreML 화자 분리 Swift SDK](https://github.com/FluidInference/FluidAudio)
- [FluidInference/speaker-diarization-coreml](https://huggingface.co/FluidInference/speaker-diarization-coreml)
- [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1)
- [pyannote-onnx — ONNX 추론](https://github.com/pengzhendong/pyannote-onnx)
- [pyannote-onnx-extended — 순수 ONNX RT 파이프라인](https://github.com/samson6460/pyannote-onnx-extended)
- [onnx-community/pyannote-segmentation-3.0](https://huggingface.co/onnx-community/pyannote-segmentation-3.0)
- [diart — 실시간 화자 분리 Python 프레임워크](https://github.com/juanmc2005/diart)
- [sherpa-onnx — 오프라인 음성 처리 C++](https://github.com/k2-fsa/sherpa-onnx)
- [WeSpeaker — 화자 임베딩 툴킷](https://github.com/wenet-e2e/wespeaker)
- [WeSpeaker ECAPA-TDNN 512 사전훈련 모델](https://huggingface.co/Wespeaker/wespeaker-ecapa-tdnn512-LM)
- [3D-Speaker — 다중모달 화자 인식](https://github.com/modelscope/3D-Speaker)
- [tinydiarize — whisper.cpp 화자 변경 토큰](https://github.com/akashmjn/tinydiarize)
- [whisper.cpp Diarization Issue #64](https://github.com/ggml-org/whisper.cpp/issues/64)
- [whisper.cpp tinydiarize PR #1058](https://github.com/ggml-org/whisper.cpp/pull/1058)
- [WhisperX — Whisper + 강제정렬 + 화자분리](https://github.com/m-bain/whisperX)
- [Picovoice Falcon — 온디바이스 화자 분리](https://picovoice.ai/platform/falcon/)
- [NVIDIA Streaming Sortformer](https://developer.nvidia.com/blog/identify-speakers-in-meetings-calls-and-voice-apps-in-real-time-with-nvidia-streaming-sortformer/)
- [SpectralCluster — Google 화자 클러스터링](https://github.com/wq2012/SpectralCluster)
- [ECAPA-TDNN 화자 임베딩](https://arxiv.org/abs/2104.01466)
- [SpeechBrain ECAPA-TDNN](https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb)
- [Near-Real-Time Speaker Diarization on CoreML](https://inference.plus/p/low-latency-speaker-diarization-on)

## 부록 B: FluidAudio 빠른 시작 예제

```swift
// Package.swift 의존성 추가
// .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.12.4")

import FluidAudioSwift

// 초기화
let diarizer = DiarizerManager()
try await diarizer.initialize()

// 오프라인 diarization
let audioSamples: [Float] = // 16kHz mono float32
let result = try await diarizer.performCompleteDiarization(
    audioSamples,
    sampleRate: 16000
)

for segment in result.segments {
    print("Speaker \(segment.speakerId): \(segment.startTimeSeconds)s - \(segment.endTimeSeconds)s")
}

// 스트리밍 diarization (실시간)
let config = DiarizerConfig(
    clusteringThreshold: 0.7,
    minSpeechDuration: 1.0,
    minSilenceGap: 0.5
)
// 5초 청크마다 processChunk 호출
```

## 부록 C: 의사 결정 로그

| 결정 | 선택 | 근거 |
|------|------|------|
| 주요 프레임워크 | FluidAudio | CoreML 네이티브, ANE 가속, Swift SDK, MIT, 60x RT |
| 임베딩 모델 | WeSpeaker ECAPA-TDNN 512 | 26MB, EER 0.67%, ONNX/CoreML 지원 |
| 클러스터링 방식 | 온라인 코사인 유사도 + 이동 평균 | 실시간 호환, O(n) 복잡도, Accelerate 가속 |
| pyannote 직접 사용 안 함 | FluidAudio가 이미 CoreML 변환 완료 | PyTorch→CoreML 변환의 동적 그래프 문제 회피 |
| Picovoice Falcon 미채택 | AccessKey 필요 (상용 라이선스) | 오프라인이지만 라이선스 제약 |
| NVIDIA Sortformer 미채택 | CUDA 전용, Apple Silicon 미지원 | 아키텍처 참고만 |
| tinydiarize 미채택 | 실험적, PoC 수준 | 정확도 부족, 화자 "식별"이 아닌 "변경 감지"만 |
