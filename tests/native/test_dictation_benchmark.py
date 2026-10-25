"""Runner tests use fake local executables and generated silent PCM, never a model."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave

SCRIPT = Path(__file__).resolve().parents[1] / "run_dictation_benchmark.py"
spec = importlib.util.spec_from_file_location("dictation_benchmark", SCRIPT)
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


class DictationBenchmarkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dictation-runner-test-")
        self.directory = Path(self.temp.name)
        self.audio = self.directory / "sample.wav"
        with wave.open(str(self.audio), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes(b"\0\0" * 1600)

    def tearDown(self):
        self.temp.cleanup()

    def fake_binary(self, body):
        binary = self.directory / "fake-transrator"
        binary.write_text(f"#!{sys.executable}\n{body}\n", encoding="utf-8")
        binary.chmod(0o755)
        return binary

    def payload_binary(self, hypothesis, **overrides):
        payload = {
            "hypothesis": hypothesis, "total_processing_ms": 20,
            "audio_duration_ms": 100, "rtf": 0.2, "timed_out": False,
        }
        payload.update(overrides)
        return self.fake_binary(f"print({json.dumps(json.dumps(payload, ensure_ascii=False))})")

    def run_case(self, binary, reference="日本語", **options):
        return benchmark.run_case(binary, self.audio, reference, "ja", options.pop("timeout", 1), **options)

    def test_normalization_is_multilingual_and_width_independent(self):
        self.assertEqual(benchmark.normalize("ＡＢＣ、 日本 語！ 한글."), "abc日本語한글")

    def test_edit_distance_counts_insertions_deletions_and_substitutions(self):
        self.assertEqual(benchmark.edit_distance("日本語", "日本語"), 0)
        self.assertEqual(benchmark.edit_distance("日本語", "日本"), 1)
        self.assertEqual(benchmark.edit_distance("日本語", "日本語文"), 1)
        self.assertEqual(benchmark.edit_distance("日本語", "日木語"), 1)
        self.assertEqual(benchmark.edit_distance("", "abc"), 3)

    def test_startup_logs_do_not_hide_benchmark_json(self):
        self.assertEqual(benchmark.parse_payload('startup {not-json}\n{"hypothesis":"ok"}\n')["hypothesis"], "ok")

    def test_matching_transcript_has_zero_cer_and_keeps_timing(self):
        result = self.run_case(self.payload_binary("日本語。"))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["cer"], 0)
        self.assertEqual(result["native_processing_ms"], 20)
        self.assertGreater(result["wall_ms"], 0)

    def test_command_selects_dictation_language_and_local_model_without_shell_quoting(self):
        model = self.directory / "a model with spaces.bin"
        model.write_bytes(b"test-only")
        payload = {"hypothesis": "日本語", "total_processing_ms": 20,
                   "audio_duration_ms": 100, "rtf": 0.2, "timed_out": False}
        body = (
            "import json, sys\n"
            "assert '--dictation' in sys.argv\n"
            "assert sys.argv[sys.argv.index('--language') + 1] == 'ja'\n"
            f"assert sys.argv[sys.argv.index('--model') + 1] == {str(model)!r}\n"
            f"print({json.dumps(json.dumps(payload))})"
        )
        self.assertEqual(self.run_case(self.fake_binary(body), model=model)["status"], "ok")

    def test_partial_noise_is_visible_even_when_final_is_empty(self):
        result = self.run_case(self.payload_binary("", partials=["", "noise"]), reference="")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["nonempty_partials"], 1)

    def test_invalid_partial_payload_is_rejected(self):
        result = self.run_case(self.payload_binary("", partials=[42]), reference="")
        self.assertEqual(result["status"], "invalid_result")

    def test_gate_comparison_flag_is_explicit(self):
        payload = {"hypothesis": "日本語", "total_processing_ms": 20,
                   "audio_duration_ms": 100, "rtf": 0.2, "timed_out": False}
        binary = self.fake_binary("import sys\nassert '--benchmark-no-denoise' in sys.argv\n" + f"print({json.dumps(json.dumps(payload))})")
        self.assertEqual(self.run_case(binary, denoise=False)["status"], "ok")

    def test_empty_speech_result_is_a_failure_instead_of_skipped_sample(self):
        result = self.run_case(self.payload_binary(""))
        self.assertEqual(result["status"], "empty_result")
        self.assertEqual(result["cer"], 1)
        self.assertEqual(benchmark.summarize([result])["empty_speech_results"], 1)

    def test_silence_with_unexpected_text_is_reported_without_dividing_by_zero(self):
        result = self.run_case(self.payload_binary("幻覚"), reference="")
        self.assertEqual(result["status"], "unexpected_text")
        self.assertIsNone(result["cer"])
        self.assertEqual(benchmark.summarize([result])["unexpected_silence_text"], 1)

    def test_silent_audio_and_empty_hypothesis_are_valid(self):
        self.assertEqual(self.run_case(self.payload_binary(""), reference="")["status"], "ok")

    def test_process_timeout_is_recorded(self):
        result = self.run_case(self.fake_binary("import time; time.sleep(1)"), timeout=0.03)
        self.assertEqual(result["status"], "timeout")
        self.assertTrue(result["timed_out"])

    def test_success_diagnostics_preserve_native_output(self):
        result = self.run_case(self.payload_binary("日本語"), diagnostics_dir=self.directory / "logs")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(benchmark.parse_payload(Path(result["stdout_path"]).read_text())["hypothesis"], "日本語")
        self.assertTrue(Path(result["stderr_path"]).is_file())

    def test_timeout_diagnostics_preserve_partial_stderr(self):
        timeout = subprocess.TimeoutExpired(["native-benchmark"], 0.1,
                                            output=b"partial output", stderr=b"loading")
        with patch.object(benchmark.subprocess, "run", side_effect=timeout):
            result = self.run_case(self.payload_binary("unused"), timeout=0.1,
                                   diagnostics_dir=self.directory / "logs")
        self.assertEqual(result["status"], "timeout")
        self.assertIn("loading", Path(result["stderr_path"]).read_text())

    def test_nonzero_exit_is_not_silently_dropped(self):
        result = self.run_case(self.fake_binary("import sys; print('failed', file=sys.stderr); sys.exit(9)"))
        self.assertEqual(result["status"], "process_error")
        self.assertEqual(result["exit_code"], 9)
        self.assertIn("failed", result["error"])

    def test_malformed_or_incomplete_results_are_rejected(self):
        self.assertEqual(self.run_case(self.fake_binary("print('not json')"))["status"], "invalid_result")
        self.assertEqual(self.run_case(self.payload_binary("日本語", rtf=float("nan")))["status"], "invalid_result")
        self.assertEqual(self.run_case(self.payload_binary("日本語", audio_duration_ms=0))["status"], "invalid_result")

    def test_missing_audio_is_measured_as_failure_without_crashing_summary(self):
        self.audio.unlink()
        result = self.run_case(self.payload_binary("日本語"))
        self.assertEqual(result["status"], "missing_audio")
        self.assertEqual(result["wall_ms"], 0)
        self.assertEqual(benchmark.summarize([result])["failed_samples"], 1)

    def test_native_timeout_is_not_mislabeled_as_success(self):
        self.assertEqual(self.run_case(self.payload_binary("日本語", timed_out=True))["status"], "timeout")

    def test_audio_repetition_stays_in_one_process_and_reports_exact_phrase_counts(self):
        result = self.run_case(self.payload_binary("日本語日本語日本語"), repetitions=3)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["cer"], 0)
        self.assertEqual(result["repetition_observation"]["exact_phrase_count"], 3)
        repeated = self.directory / "repeated.wav"
        benchmark.repeat_wav(self.audio, repeated, 3)
        with wave.open(str(repeated), "rb") as audio:
            self.assertEqual(audio.getnframes(), 1600 * 3 + 6400 * 2)

    def test_cli_writes_failure_report_and_exits_unsuccessfully(self):
        manifest = self.directory / "manifest.json"
        manifest.write_text(json.dumps({"language": "ja", "samples": [{"filename": "sample.wav", "transcript": "日本語"}]}))
        output = self.directory / "report.json"
        process = subprocess.run([
            sys.executable, str(SCRIPT), "--binary", str(self.payload_binary("")),
            "--manifest", str(manifest), "--output", str(output),
        ], capture_output=True, text=True, timeout=3)
        self.assertEqual(process.returncode, 1)
        self.assertEqual(json.loads(output.read_text())["summary"]["failed_samples"], 1)


if __name__ == "__main__":
    unittest.main()
