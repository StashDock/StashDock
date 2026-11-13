fn main() {
    #[cfg(target_os = "macos")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=native/PreviewRenderer.swift");
        println!("cargo:rerun-if-changed=src/preview_ready.js");
        let target = std::env::var("TARGET").expect("Cargo target");
        let arch = match target.split('-').next().unwrap() {
            "aarch64" => "arm64",
            "x86_64" => "x86_64",
            _ => panic!("Unsupported Mac renderer architecture"),
        };
        println!("cargo:rerun-if-changed=native/PreviewRenderer-Info.plist");
        let directory = std::path::Path::new("native-binaries/StashDockRenderer.app/Contents");
        std::fs::create_dir_all(directory.join("MacOS")).expect("Create native helper bundle");
        std::fs::create_dir_all(directory.join("Resources")).expect("Create renderer resources");
        let readiness = std::fs::read("src/preview_ready.js").expect("Read viewport readiness probe");
        std::fs::write(directory.join("Resources/preview-ready.js"), &readiness).expect("Embed viewport readiness probe");
        let info = std::fs::read_to_string("native/PreviewRenderer-Info.plist")
            .expect("Native renderer bundle metadata")
            .replace("${VERSION}", env!("CARGO_PKG_VERSION"));
        std::fs::write(directory.join("Info.plist"), &info).expect("Write native helper metadata");
        let binary = directory.join("MacOS/stashdock-render");
        let status = std::process::Command::new("xcrun")
            .args([
                "swiftc",
                "-parse-as-library",
                "-O",
                "-target",
                &format!("{arch}-apple-macos14.0"),
                "native/PreviewRenderer.swift",
                "-o",
            ])
            .arg(&binary)
            .status()
            .expect("Xcode Swift compiler");
        assert!(status.success(), "Build native WebKit/PDFKit renderer");
        let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
        println!("cargo:rerun-if-changed=native/FolderSearch.swift");
        println!("cargo:rerun-if-changed=native/SearchTokens.generated.swift");
        println!("cargo:rerun-if-changed=native/SearchPresentation.swift");
        println!("cargo:rerun-if-changed=native/SearchControls.swift");
        println!("cargo:rerun-if-changed=native/WindowHandoff.swift");
        println!("cargo:rerun-if-changed=native/WindowChrome.swift");
        println!("cargo:rerun-if-changed=native/WindowHandoffTokens.generated.swift");
        let archive = out.join("libStashDockSearch.a");
        let status = std::process::Command::new("xcrun")
            .args([
                "swiftc",
                "-parse-as-library",
                "-swift-version",
                "6",
                "-O",
                "-emit-library",
                "-static",
                "-target",
                &format!("{arch}-apple-macos14.0"),
                "native/FolderSearch.swift",
                "native/SearchTokens.generated.swift",
                "native/SearchPresentation.swift",
                "native/SearchControls.swift",
                "native/WindowHandoff.swift",
                "native/WindowChrome.swift",
                "native/WindowHandoffTokens.generated.swift",
                "-o",
            ])
            .arg(&archive)
            .status()
            .expect("Xcode Swift compiler");
        assert!(status.success(), "Build in-process native folder search");
        println!("cargo:rustc-link-search=native={}", out.display());
        println!("cargo:rustc-link-lib=static=StashDockSearch");
        let toolchain = std::process::Command::new("xcrun")
            .args(["--find", "swiftc"])
            .output()
            .expect("Swift toolchain");
        let swiftc = String::from_utf8(toolchain.stdout).unwrap();
        let libraries = std::path::Path::new(swiftc.trim())
            .parent()
            .unwrap()
            .join("../lib/swift/macosx");
        println!("cargo:rustc-link-search=native={}", libraries.display());
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=QuartzCore");
        println!("cargo:rustc-link-lib=framework=WebKit");
        println!("cargo:rerun-if-changed=../assets/generated/native-reference-icons.json");
        let icons: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string("../assets/generated/native-reference-icons.json")
                .expect("Generate native icons"),
        )
        .expect("Native icon catalog");
        let mut raster = serde_json::Map::new();
        for (name, icon) in icons.as_object().unwrap() {
            use base64::Engine;
            let svg = format!(
                "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {} {}\">{}</svg>",
                icon["width"],
                icon["height"],
                icon["body"].as_str().unwrap()
            );
            let tree = resvg::usvg::Tree::from_str(&svg, &resvg::usvg::Options::default()).unwrap();
            let pixels = if name.starts_with("control_") {
                64
            } else {
                256
            };
            let mut png = resvg::tiny_skia::Pixmap::new(pixels, pixels).unwrap();
            resvg::render(
                &tree,
                resvg::tiny_skia::Transform::from_scale(
                    pixels as f32 / tree.size().width(),
                    pixels as f32 / tree.size().height(),
                ),
                &mut png.as_mut(),
            );
            raster.insert(
                name.clone(),
                format!(
                    "data:image/png;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(png.encode_png().unwrap())
                )
                .into(),
            );
        }
        std::fs::write(
            out.join("native-reference-icons.json"),
            serde_json::to_vec(&raster).unwrap(),
        )
        .unwrap();
        let profile = out.ancestors().nth(3).expect("Cargo profile directory");
        let staged = profile.join("StashDockRenderer.app/Contents");
        std::fs::create_dir_all(staged.join("MacOS")).expect("Stage native helper bundle");
        std::fs::create_dir_all(staged.join("Resources")).expect("Stage renderer resources");
        std::fs::write(staged.join("Resources/preview-ready.js"), &readiness).expect("Stage viewport readiness probe");
        std::fs::copy(&binary, staged.join("MacOS/stashdock-render"))
            .expect("Stage native renderer executable");
        std::fs::write(staged.join("Info.plist"), info).expect("Stage native renderer metadata");
        for suffix in ["", "-rear", "-cards", "-front"] {
            let source = format!("../assets/generated/folder-native{suffix}.svg");
            println!("cargo:rerun-if-changed={source}");
            let svg =
                std::fs::read_to_string(&source).expect("Run scripts/generate-native-folder.mjs");
            let mut options = resvg::usvg::Options::default();
            // Only bundled data images (the shared brand) are allowed. No disk/network hrefs.
            options.image_href_resolver.resolve_string = Box::new(|_, _| None);
            let tree =
                resvg::usvg::Tree::from_str(&svg, &options).expect("Valid shared folder artwork");
            let mut image = resvg::tiny_skia::Pixmap::new(432, 432).expect("Folder raster");
            resvg::render(
                &tree,
                resvg::tiny_skia::Transform::from_scale(1.2, 1.2),
                &mut image.as_mut(),
            );
            image
                .save_png(
                    std::path::Path::new(&std::env::var_os("OUT_DIR").unwrap())
                        .join(format!("floating-folder{suffix}.png")),
                )
                .expect("Write native folder image");
        }
    }
    // The resource compiler reads this outside Rust include_bytes!, so Cargo
    // needs an explicit dependency to avoid retaining a stale Shell icon.
    if std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os == "windows") {
        println!("cargo:rerun-if-changed=icons/icon.ico");
    }
    tauri_build::build()
}
