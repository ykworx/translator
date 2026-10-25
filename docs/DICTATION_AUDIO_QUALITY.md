# 받아쓰기 음질 개선 계획과 검증

TV 속 실제 대사가 입력되는 **배경 화자 혼입**과 무음·생활 소음에서 없는 문장이 생성되는 **환각**을 분리해 다룹니다. VAD는 사람의 말소리를 감지하며 사용자 신원을 확인하지 않습니다.

## 1차 구현

- 마이크와 전역 받아쓰기의 중간·최종 인식에 같은 음성 감지를 적용합니다.
- RNNoise로 소음을 줄인 신호에서 Core ML Silero VAD를 실행하고, 선택된 **원본 PCM**을 Whisper에 전달합니다. 잡음 억제로 음성 자체가 변형돼 인식률이 떨어지는 일을 줄이기 위한 선택입니다.
- 짧은 검출 결과에 원본 소음을 다시 넣지 않습니다. 경계 100ms를 보존하고 필요한 문맥 길이는 무음으로 채웁니다. 인접 구간의 경계는 병합해 같은 음성을 중복 삽입하지 않습니다.
- 최종적으로 음성이 없으면 해당 중간 초안만 비웁니다. 이전에 확정한 발화는 보존합니다.
- Whisper 실패 반환값을 검사하고, 개발 실행 파일의 VAD 리소스 검색 경로를 보완합니다.
- 기존 단축키·권한·모델 선택·외부 앱 삽입 정책은 변경하지 않습니다. RNNoise 준비가 실패하면 기존 원본 VAD로 복귀하며 벤치마크의 `rnnoise_fallback`으로 구분합니다.

## 재현 가능한 오프라인 시험

모델 다운로드나 실제 녹음 없이 설치된 Whisper 모델과 생성 WAV를 사용합니다. 기본 생성기는 저장소의 일본어 합성 음성과 고정 seed 소음을 사용합니다. 한국어 추가 시험은 명시적으로 선택한 **설치된** macOS TTS 음성으로 파일을 만듭니다. 스피커 재생이나 마이크 캡처를 하지 않습니다.

```bash
python3 tests/prepare_noise_cases.py --output /tmp/transrator-audio-cases --korean-voice Yuna
python3 tests/run_dictation_benchmark.py \
  --binary src-tauri/target/release/tauri-app \
  --manifest /tmp/transrator-audio-cases/manifest.json --limit 0 \
  --output /tmp/transrator-audio-gated.json
# 같은 수정 빌드에서 RNNoise gate만 끄는 비교
python3 tests/run_dictation_benchmark.py \
  --binary src-tauri/target/release/tauri-app \
  --manifest /tmp/transrator-audio-cases/manifest.json --limit 0 --no-denoise \
  --output /tmp/transrator-audio-ungated.json
bash tests/run_native_dictation_tests.sh
bash tests/run_speech_audio_tests.sh
```

출력 디렉토리는 새 경로여야 합니다. 한국어 음성이 설치돼 있지 않으면 `--korean-voice`를 생략합니다. TV 대역으로 쓰는 합성 배경 화자는 `background_voice_probe`, 동시 발화는 `overlapping_voice_probe`입니다. 배경 화자만 있는 시험의 `unexpected_text`는 현재 미지원인 화자 선택의 한계를 드러내는 결과이며 숨기지 않습니다. `status=ok`는 CER가 0이라는 뜻이 아닙니다. CER, 비음성 오출력, `nonempty_partials`, 시간 지표를 각각 확인합니다.

### 2026-10-25 초기 비교

Apple M2 Max, 로컬 Large V3 Turbo와 Core ML encoder, 생성 사례 10개를 순차 실행했습니다. 기준은 `195969b` 앱이며, 아래 수치는 기본 적용 경로를 재시험한 결과입니다.

| 지표 | 기준 앱 | RNNoise로 감지 + 원본 PCM 인식 |
|---|---:|---:|
| 비음성 3개에서 최종 오출력 발생 사례 | 1 | 0 |
| 비음성 3개에서 중간 오출력 발생 사례 | 2 | 0 |
| 한국어 단답 “네” 인식 | 유지 | 유지 |
| 발화 표본 합산 문자 오류율 | 1.61% | 0.81% |
| native 처리 시간 중앙값 | 1711ms | 1838ms |
| 배경 화자만 있는 시험의 차단 | 실패 | 실패 |

RNNoise 출력 자체를 Whisper에 넣는 방안도 비교했으나 합산 CER 3.23%로 악화돼 기본 경로로 채택하지 않았습니다. 현재 방식의 처리 중앙값 증가는 약 7%입니다. 별도의 기존 일본어 합성 발화 10개에서는 CER가 기준·수정 모두 3.90%였고, native 처리 중앙값은 1746→1968ms(약 13% 증가), 최대 RTF는 0.281→0.295였습니다. 품질 보존과 처리 비용을 함께 기록합니다. 결과는 작은 합성 표본이며 자연스러운 한국어·다른 마이크·실제 TV 환경에서의 개선을 입증하지 않습니다. 원문 “세”와 결과 “3” 같은 표기 차이도 현재 CER에 포함됩니다. 최초 Core ML 캐시 준비는 별도 비용이 있으며, 개발 경로의 첫 실행에서 wall time 약 52초가 관찰됐습니다. 중앙값만으로 최초 준비 지연을 설명하지 않습니다.

## Apple Silicon 가속

| 단계 | 현재 정책 | 확인 방법 |
|---|---|---|
| Whisper decoder 등 | Metal GPU 사용 요청, Accelerate 빌드 | native 로그의 Metal backend 선택, `whisper_build_features` |
| Whisper encoder | 설치된 Core ML encoder 로딩, `MLComputeUnits.all` | native 로그의 `Core ML model loaded` |
| Silero VAD | Core ML, `computeUnits = .all` | `vad_loaded`, `coreml_vad_process` 시간 |
| RNNoise·리샘플링 | CPU 네이티브 처리, inference queue | `rnnoise` 시간, 원본 오디오 tap에서 분리 |

M2 Max 시험에서 Metal backend 선택과 Core ML encoder/VAD 로딩을 확인했습니다. VAD 호출은 초기 실험에서 평균 약 0.35–0.46ms였습니다. `.all`은 OS가 CPU·GPU·Neural Engine 중 사용할 장치를 고르게 하는 정책입니다. **Neural Engine에서 모든 연산이 실행됐다는 측정 결과는 아닙니다.** 장치별 점유율은 Instruments/Core ML 프로파일링이 별도로 필요합니다. 작은 RNNoise 프레임을 GPU로 옮기는 방안은 전송 비용과 전력까지 측정하기 전에는 채택하지 않습니다.

근거: [whisper.cpp Core ML](https://github.com/ggml-org/whisper.cpp#core-ml-support), [Apple MLComputeUnits](https://developer.apple.com/documentation/coreml/mlcomputeunits), [RNNoise](https://github.com/xiph/rnnoise).

## 2차: ‘내 목소리만’ 도입 검토

화자 임베딩으로 다른 사람의 발화를 거르는 기능과, 동시에 겹친 두 사람의 음성을 분리하는 기능을 구분합니다. 임베딩 비교만으로 동시 발화에서 TV 대사를 제거했다고 주장하지 않습니다.

| 후보 | 확인된 역할 | 현재 결정 |
|---|---|---|
| [FluidAudio](https://github.com/FluidInference/FluidAudio) | Swift/Core ML 화자 임베딩·diarization 제공 | Apple 가속 화자 비교 PoC 우선 검토. 선택한 가중치의 라이선스·최소 OS·짧은 발화 성능 확인 필요 |
| [WeSpeaker](https://github.com/wenet-e2e/wespeaker) | 임베딩·화자 검증, ONNX export 제공 | 비교 기준 후보. 제공 ONNX GPU 문서는 CUDA 기준이므로 Mac Neural Engine 지원으로 해석하지 않음 |
| [WeSep](https://github.com/wenet-e2e/wesep) | 대상 화자 추출 연구 도구, 코드 Apache-2.0 | 실제 동시 발화 해결의 연구 후보. 현재 문서는 production deployment 미지원·공식 pretrained/CLI 검증 중이므로 즉시 앱 통합하지 않음 |
| [SpeakerBeam](https://github.com/BUTSpeechFIT/speakerbeam) | 대상 화자 추출 | 저장소의 evaluation-only 라이선스 때문에 현재 MIT 앱 배포 의존성으로 선택하지 않음 |
| [ClearVoice](https://github.com/modelscope/ClearerVoice-Studio/tree/main/clearvoice) | enhancement/separation, 공개 TSE는 audio-visual | 공개 TSE 모델이 영상 단서를 요구하므로 마이크 전용 음성 등록 기능에 바로 대입하지 않음 |

다음 순서로 별도 PoC를 진행합니다.

1. 합성 또는 명시적 동의를 받은 시험용 화자를 등록하고, 단독 발화의 본인/타인 판별을 측정합니다. 실제 사용자 음성을 자동 등록하지 않습니다.
2. 조용한 환경, TV만, 사용자만, 번갈아 말하기, 동시에 말하기를 나눠 배경 화자 오수락률·사용자 오거절률·CER·지연·메모리를 측정합니다.
3. 가중치 재배포 조건과 Core ML 변환/실제 실행 장치를 확인합니다. 코드 라이선스만으로 모델 재배포를 허용한다고 판단하지 않습니다.
4. 제품 옵션은 기본 꺼짐으로 설계합니다. 등록·품질 확인·로컬 저장·전체 삭제·마이크 변경 시 재확인을 포함하고, 짧거나 신원 판정이 불확실한 발화를 몰래 폐기하지 않는 복구 UX를 먼저 정합니다.

현재 패치에는 신규 화자 모델, 사용자 음성 프로필 수집, 클라우드 전송이나 Python 런타임 의존성을 추가하지 않습니다.
