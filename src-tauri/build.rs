fn emit_build_info() {
    use std::{env, path::PathBuf, process::Command, time::{SystemTime, UNIX_EPOCH}};
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).parent().unwrap().to_owned();
    let git = |args: &[&str]| Command::new("git").current_dir(&root).args(args).output().ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok()).map(|value| value.trim().to_owned());
    // Watch source and Git metadata so rebuilding after edits/commits cannot keep an old identity.
    if let Some(files) = git(&["ls-files"]) {
        for file in files.lines() { println!("cargo:rerun-if-changed={}", root.join(file).display()); }
    }
    for name in ["HEAD", "index", "packed-refs"] {
        if let Some(path) = git(&["rev-parse", "--git-path", name]) {
            println!("cargo:rerun-if-changed={}", root.join(path).display());
        }
    }
    if let Some(branch) = git(&["symbolic-ref", "-q", "HEAD"]) {
        if let Some(path) = git(&["rev-parse", "--git-path", &branch]) {
            println!("cargo:rerun-if-changed={}", root.join(path).display());
        }
    }
    for name in ["TRANSRATOR_BUILD_CHANNEL", "TRANSRATOR_BUILD_NUMBER"] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    let channel = env::var("TRANSRATOR_BUILD_CHANNEL").unwrap_or_else(|_| "development".into());
    assert!(["development", "validation", "release"].contains(&channel.as_str()), "Invalid build channel");
    let build_number = env::var("TRANSRATOR_BUILD_NUMBER").ok();
    if let Some(number) = &build_number {
        let parts: Vec<_> = number.split('.').collect();
        assert!(parts.len() == 2 && parts.iter().enumerate().all(|(index, part)| {
            !part.starts_with('0') && part.bytes().all(|byte| byte.is_ascii_digit())
                && part.parse::<u32>().is_ok_and(|value| value > 0 && value <= if index == 0 { 9999 } else { 99 })
        }), "Build number must be RUN.ATTEMPT (1..9999 and 1..99)");
    }
    let revision = git(&["rev-parse", "HEAD"]).filter(|value| value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let dirty = git(&["status", "--porcelain", "--untracked-files=no"]).is_some_and(|value| !value.is_empty());
    if channel != "development" {
        assert!(revision.is_some() && !dirty && build_number.is_some(), "CI builds require a clean Git revision and build number");
    }
    let info = serde_json::json!({
        "version": env::var("CARGO_PKG_VERSION").unwrap(),
        "revision": revision, "dirty": dirty, "channel": channel, "buildNumber": build_number,
        "builtAtUnixSeconds": SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs(),
    });
    std::fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("build-info.json"), info.to_string()).unwrap();
}

#[cfg(target_os = "macos")]
fn main() {
    emit_build_info();
    use std::{env, path::PathBuf, process::Command};

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SwiftTargetInfo {
        paths: SwiftPaths,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SwiftPaths {
        runtime_library_paths: Vec<String>,
    }

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("missing manifest dir"));
    let swift_dir = manifest_dir.join("swift");
    let swift_files: Vec<PathBuf> = vec![
        swift_dir.join("SwiftBridgeUtils.swift"),
        swift_dir.join("DictationState.swift"),
        swift_dir.join("DictationClipboard.swift"),
        swift_dir.join("GlobalDictation.swift"),
        swift_dir.join("MicrophoneDevices.swift"),
        swift_dir.join("PerformanceTracker.swift"),
        swift_dir.join("CoreMLVad.swift"),
        swift_dir.join("SpeechAudioPolicy.swift"),
        swift_dir.join("SpeechDenoiser.swift"),
        swift_dir.join("MicSpeechBridge.swift"),
        swift_dir.join("AppCaptionBridge.swift"),
        swift_dir.join("WhisperEngine.swift"),
    ];
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("missing out dir"));
    let library_path = out_dir.join("libspeech_bridge.a");
    let module_cache_path = out_dir.join("swift-module-cache");
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").expect("missing target arch");
    let swift_arch = if target_arch == "aarch64" { "arm64" } else { target_arch.as_str() };

    // --- Build whisper.cpp via cmake ---
    let whisper_src = manifest_dir.join("vendor/whisper.cpp");
    let whisper_build = out_dir.join("whisper-build");
    std::fs::create_dir_all(&whisper_build).expect("failed to create whisper build dir");

    // Track all whisper.cpp source files for rebuild detection
    println!("cargo:rerun-if-changed={}", whisper_src.join("CMakeLists.txt").display());
    println!("cargo:rerun-if-changed={}", whisper_src.join("src/whisper.cpp").display());
    println!("cargo:rerun-if-changed={}", whisper_src.join("src/coreml/whisper-encoder.mm").display());
    println!("cargo:rerun-if-changed={}", whisper_src.join("include/whisper.h").display());
    println!("cargo:rerun-if-changed={}", whisper_src.join("ggml/src").display());

    // Only run cmake configure if not already configured
    let cmake_cache = whisper_build.join("CMakeCache.txt");
    if !cmake_cache.exists() {
        let cmake_status = Command::new("cmake")
            .current_dir(&whisper_build)
            .args([
                whisper_src.to_str().unwrap(),
                "-DCMAKE_BUILD_TYPE=Release",
                "-DBUILD_SHARED_LIBS=OFF",
                "-DWHISPER_BUILD_EXAMPLES=OFF",
                "-DWHISPER_BUILD_TESTS=OFF",
                "-DWHISPER_BUILD_SERVER=OFF",
                "-DGGML_METAL=ON",
                "-DGGML_ACCELERATE=ON",
                "-DGGML_BLAS=OFF",
                "-DWHISPER_COREML=ON",
                "-DWHISPER_COREML_ALLOW_FALLBACK=ON",
                &format!("-DCMAKE_OSX_ARCHITECTURES={swift_arch}"),
            ])
            .status()
            .expect("failed to run cmake configure for whisper.cpp");
        if !cmake_status.success() {
            panic!("cmake configure failed for whisper.cpp");
        }
    }

    // cmake --build is incremental — no-op if nothing changed
    let build_status = Command::new("cmake")
        .args(["--build", whisper_build.to_str().unwrap(), "--config", "Release", "-j"])
        .status()
        .expect("failed to run cmake build for whisper.cpp");
    if !build_status.success() {
        panic!("cmake build failed for whisper.cpp");
    }

    // Find and link whisper static libraries
    // cmake produces: libwhisper.a, libggml.a, libggml-base.a, libggml-cpu.a, libggml-metal.a
    let whisper_lib_dir = whisper_build.join("src");
    let ggml_lib_dir = whisper_build.join("ggml/src");

    println!("cargo:rustc-link-search=native={}", whisper_lib_dir.display());
    println!("cargo:rustc-link-search=native={}", ggml_lib_dir.display());
    println!("cargo:rustc-link-search=native={}", ggml_lib_dir.join("ggml-cpu").display());
    println!("cargo:rustc-link-search=native={}", ggml_lib_dir.join("ggml-metal").display());

    println!("cargo:rustc-link-lib=static=whisper");
    println!("cargo:rustc-link-lib=static=whisper.coreml");
    println!("cargo:rustc-link-lib=static=ggml");
    println!("cargo:rustc-link-lib=static=ggml-base");
    println!("cargo:rustc-link-lib=static=ggml-cpu");
    println!("cargo:rustc-link-lib=static=ggml-metal");

    // --- Build RNNoise static library ---
    let rnnoise_dir = manifest_dir.join("vendor/rnnoise");
    println!("cargo:rerun-if-changed={}", rnnoise_dir.join("src/denoise.c").display());
    println!("cargo:rerun-if-changed={}", rnnoise_dir.join("include/rnnoise.h").display());

    cc::Build::new()
        .files(&[
            rnnoise_dir.join("src/denoise.c"),
            rnnoise_dir.join("src/rnn.c"),
            rnnoise_dir.join("src/rnn_data.c"),
            rnnoise_dir.join("src/pitch.c"),
            rnnoise_dir.join("src/kiss_fft.c"),
            rnnoise_dir.join("src/celt_lpc.c"),
        ])
        .include(rnnoise_dir.join("include"))
        .include(rnnoise_dir.join("src"))
        .define("COMPILE_OPUS", None)
        .opt_level(3)
        .compile("rnnoise");

    // --- Rerun triggers for Swift files ---
    for sf in &swift_files {
        println!("cargo:rerun-if-changed={}", sf.display());
    }
    println!("cargo:rerun-if-changed={}", swift_dir.join("whisper-bridge.h").display());

    // --- Link search & framework declarations ---
    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=static=speech_bridge");

    // Frameworks
    println!("cargo:rustc-link-lib=framework=AVFoundation");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rustc-link-lib=framework=ApplicationServices");
    println!("cargo:rustc-link-lib=framework=ScreenCaptureKit");
    println!("cargo:rustc-link-lib=framework=CoreGraphics");
    println!("cargo:rustc-link-lib=framework=CoreMedia");
    println!("cargo:rustc-link-lib=framework=CoreAudio");
    println!("cargo:rustc-link-lib=framework=AudioToolbox");
    println!("cargo:rustc-link-lib=framework=Metal");
    println!("cargo:rustc-link-lib=framework=MetalKit");
    println!("cargo:rustc-link-lib=framework=Accelerate");
    println!("cargo:rustc-link-lib=framework=CoreML");

    // C++ standard library (required by whisper.cpp)
    println!("cargo:rustc-link-lib=c++");

    // --- Resolve macOS SDK path ---
    let sdk_path_output = Command::new("xcrun")
        .args(["--sdk", "macosx", "--show-sdk-path"])
        .output()
        .expect("failed to execute xcrun");
    if !sdk_path_output.status.success() {
        panic!("failed to resolve macOS SDK path");
    }
    let sdk_path = String::from_utf8(sdk_path_output.stdout).expect("invalid sdk path");
    let sdk_path = sdk_path.trim();

    println!(
        "cargo:rustc-link-search=framework={}/System/Library/Frameworks",
        sdk_path
    );

    // --- Resolve Swift runtime ---
    let target_info_output = Command::new("swift")
        .args(["-target", &format!("{swift_arch}-apple-macos10.15"), "-print-target-info"])
        .output()
        .expect("failed to query swift target info");
    if !target_info_output.status.success() {
        panic!("failed to query swift target info");
    }
    let target_info: SwiftTargetInfo =
        serde_json::from_slice(&target_info_output.stdout).expect("invalid swift target info");
    for path in target_info.paths.runtime_library_paths {
        println!("cargo:rustc-link-search=native={path}");
        println!("cargo:rustc-link-arg=-Wl,-rpath,{path}");
    }

    // --- Compile Swift sources ---
    // Pass -import-objc-header for the whisper C bridging header
    let bridge_header = swift_dir.join("whisper-bridge.h");
    let whisper_include = whisper_src.join("include");
    let ggml_include = whisper_src.join("ggml/include");

    let mut cmd = Command::new("xcrun");
    cmd.args([
        "--sdk",
        "macosx",
        "swiftc",
        "-parse-as-library",
        "-emit-library",
        "-static",
        "-target",
        &format!("{swift_arch}-apple-macos10.15"),
        "-sdk",
        sdk_path,
        "-module-cache-path",
        module_cache_path.to_str().expect("invalid module cache path"),
        "-import-objc-header",
        bridge_header.to_str().expect("invalid bridge header path"),
        // Add include paths for whisper.h and ggml.h
        "-Xcc", &format!("-I{}", whisper_include.display()),
        "-Xcc", &format!("-I{}", ggml_include.display()),
        "-o",
        library_path.to_str().expect("invalid output path"),
    ]);
    for sf in &swift_files {
        cmd.arg(sf.to_str().expect("invalid swift path"));
    }
    let status = cmd.status().expect("failed to run swiftc");

    if !status.success() {
        panic!("failed to compile Swift sources");
    }

    tauri_build::build()
}

#[cfg(not(target_os = "macos"))]
fn main() {
    emit_build_info();
    tauri_build::build()
}
