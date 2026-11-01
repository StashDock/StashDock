#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// A release desktop without this feature silently loads build.devUrl instead
// of the packaged frontend. Refuse to create an unusable distributable.
#[cfg(all(not(debug_assertions), dev, not(test)))]
compile_error!(
    "Release desktop builds require --features tauri/custom-protocol (or the Tauri build CLI)."
);

#[path = "independent_startup.rs"]
#[allow(dead_code)]
mod independent_startup;
fn main() {
    #[cfg(target_os = "macos")]
    if stashdock_lib::safari_services::run_status_command() {
        return;
    }
    match independent_startup::relaunch_if_needed() {
        Ok(true) => return,
        Ok(false) => {}
        Err(error) => {
            eprintln!("{error}");
            #[cfg(windows)]
            {
                use windows_sys::Win32::UI::WindowsAndMessaging::{
                    MessageBoxW, MB_ICONERROR, MB_OK,
                };
                let title: Vec<u16> = "StashDock\0".encode_utf16().collect();
                let message: Vec<u16> =
                    format!("{error}\nRestart Windows Explorer, then try again.\0")
                        .encode_utf16()
                        .collect();
                unsafe {
                    MessageBoxW(
                        std::ptr::null_mut(),
                        message.as_ptr(),
                        title.as_ptr(),
                        MB_OK | MB_ICONERROR,
                    );
                }
            }
            std::process::exit(1);
        }
    }
    stashdock_lib::run();
}
