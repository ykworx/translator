// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // CLI benchmark mode: tauri-app --benchmark-wav <path.wav> [--model <model.bin>] [--language <lang>]
    if args.len() >= 3 && args[1] == "--benchmark-wav" {
        let wav_path = &args[2];

        // Find model path: --model flag or default location
        let model_path = if let Some(idx) = args.iter().position(|a| a == "--model") {
            args.get(idx + 1).cloned()
        } else {
            None
        }.unwrap_or_else(|| {
            // Default model path
            let home = std::env::var("HOME").unwrap_or_default();
            format!("{}/Library/Application Support/com.ykworx.transrator/models/ggml-large-v3-turbo.bin", home)
        });

        // Find language: --language flag or default "ja"
        let language = if let Some(idx) = args.iter().position(|a| a == "--language") {
            args.get(idx + 1).cloned()
        } else {
            Some("ja".to_string())
        };

        // Load model via C API
        if std::path::Path::new(&model_path).exists() {
            eprintln!("[benchmark] Loading model: {}", model_path);
            tauri_app_lib::benchmark::load_model_for_benchmark(&model_path);
            eprintln!("[benchmark] Model loaded, language: {}", language.as_deref().unwrap_or("auto"));
        } else {
            eprintln!("{{\"error\": \"Model not found: {}\"}}", model_path);
            std::process::exit(1);
        }

        match tauri_app_lib::benchmark::run_wav_benchmark(wav_path.clone(), language) {
            Ok(result) => {
                println!("{}", serde_json::to_string_pretty(&result).unwrap_or_default());
            }
            Err(e) => {
                eprintln!("{{\"error\": \"{}\"}}", e);
                std::process::exit(1);
            }
        }

        // Unload model
        tauri_app_lib::benchmark::unload_model_for_benchmark();
        std::process::exit(0);
    }

    tauri_app_lib::run()
}
