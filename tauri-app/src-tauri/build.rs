#[cfg(target_os = "macos")]
fn main() {
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
        swift_dir.join("MicSpeechBridge.swift"),
        swift_dir.join("AppCaptionBridge.swift"),
    ];
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("missing out dir"));
    let library_path = out_dir.join("libspeech_bridge.a");
    let module_cache_path = out_dir.join("swift-module-cache");
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").expect("missing target arch");
    let swift_arch = if target_arch == "aarch64" { "arm64" } else { target_arch.as_str() };

    for sf in &swift_files {
        println!("cargo:rerun-if-changed={}", sf.display());
    }
    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=static=speech_bridge");
    println!("cargo:rustc-link-lib=framework=Speech");
    println!("cargo:rustc-link-lib=framework=AVFoundation");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=ScreenCaptureKit");
    println!("cargo:rustc-link-lib=framework=CoreGraphics");
    println!("cargo:rustc-link-lib=framework=CoreMedia");
    println!("cargo:rustc-link-lib=framework=CoreAudio");

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
    tauri_build::build()
}
