mod blocking_work;
mod browser_presence;
mod capture_platforms;
mod codex_presence;
mod desktop_window_policy;
mod desktop_windows;
#[cfg(not(target_os = "macos"))]
mod folder_search;
#[cfg(target_os = "macos")]
use folder_search_macos as folder_search;
mod desktop_updates;
#[cfg(target_os = "macos")]
mod folder_search_macos;
mod folder_window;
#[allow(dead_code)]
mod independent_startup;
mod integration_launch;
mod integrations;
mod native_messaging;
mod library;
mod library_location;
mod lifecycle;
mod link_import;
mod link_metadata;
#[cfg(target_os = "macos")]
mod macos_handoff;
#[cfg(target_os = "macos")]
mod macos_services;
#[cfg(target_os = "macos")]
mod macos_window;
mod preview_browser;
mod preview_cache;
mod preview_enrichment;
mod public_web;
mod reference_clipboard;
mod reference_cover;
mod reference_drag;
#[cfg(windows)]
mod reference_drag_windows;
mod reference_transfer;
#[cfg(target_os = "macos")]
mod reference_transfer_macos;
#[cfg(target_os = "macos")]
pub mod safari_services;
mod settings;
mod web_content;
mod web_images;
mod web_preview;
mod window_frame;
mod window_geometry;
mod window_morph;

use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[tauri::command]
async fn desktop_runtime_ready(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            if app.try_state::<library::LibraryState>().is_some()
                && app.try_state::<desktop_windows::DesktopWindows>().is_some()
            {
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                return Err("StashDock is still starting. Try again.".to_string());
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn preview_link(url: String) -> Result<link_metadata::LinkPreview, String> {
    if url.len() > 8192 {
        return Err("This link is too long.".into());
    }
    // A pasted link is rendered once for its text and cover (the renderer's own
    // two-page admission applies); a direct read runs alongside as a fallback.
    static WORK: blocking_work::WorkLimit = blocking_work::WorkLimit::new(4);
    WORK.run(move || link_metadata::fetch_preview_inline(&url))
        .await
}

pub fn run_browser_native_host() -> Result<(), String> {
    library::native_host::run()
}

pub fn run() {
    library::preview_protocol::register(tauri::Builder::default())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            lifecycle::show_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if app
                        .try_state::<settings::SettingsState>()
                        .is_some_and(|s| s.0.try_lock().is_err())
                    {
                        return;
                    }
                    let Some(library) = app.try_state::<library::LibraryState>() else {
                        return;
                    };
                    let Ok(preferences) = settings::read(&library) else {
                        return;
                    };
                    if preferences
                        .shortcut
                        .parse::<tauri_plugin_global_shortcut::Shortcut>()
                        .ok()
                        .as_ref()
                        != Some(shortcut)
                    {
                        return;
                    }

                    desktop_windows::toggle(app);
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            desktop_runtime_ready,
            settings::get_desktop_settings,
            integrations::get_integration_status,
            integration_launch::open_integration,
            settings::save_desktop_preferences,
            settings::set_launch_at_login,
            settings::get_storage_info,
            settings::open_storage_folder,
            settings::move_library,
            settings::restart_desktop,
            settings::check_desktop_updates,
            capture_platforms::list_capture_platforms,
            capture_platforms::save_capture_platform,
            library::commands::initialize_library,
            library::commands::save_items,
            library::commands::replace_saved_link,
            library::commands::list_items,
            library::commands::get_library_sort,
            library::commands::set_library_sort,
            library::commands::get_items,
            library::commands::set_item_favorite,
            library::commands::edit_item,
            library::commands::edit_item_content,
            library::commands::change_library_tag,
            library::commands::list_pinned_tags,
            library::commands::set_tag_pinned,
            library::commands::delete_item,
            library::commands::delete_items,
            library::commands::import_file_payloads,
            library::commands::open_reference_file,
            link_import::list_browser_sources,
            link_import::read_browser_import,
            link_import::read_browser_bookmarks,
            link_import::read_browser_bookmark_icons,
            preview_link,
            reference_cover::prepare_cover_image,
            library::commands::search_items,
            library::commands::choose_reference_files,
            library::commands::import_chosen_files,
            reference_drag::drag_reference_file,
            reference_clipboard::copy_reference_file,
            desktop_windows::desktop_window_status,
            desktop_windows::desktop_window_ready,
            desktop_windows::set_desktop_surface,
            desktop_windows::hide_stashdock,
            folder_window::drag_folder_window,
            #[cfg(not(target_os = "macos"))]
            folder_search::folder_search_pointer,
            #[cfg(not(target_os = "macos"))]
            folder_search::folder_search_hold,
            #[cfg(not(target_os = "macos"))]
            folder_search::folder_search_close,
            #[cfg(not(target_os = "macos"))]
            folder_search::folder_search_focus,
            #[cfg(not(target_os = "macos"))]
            folder_search::folder_search_region,
            #[cfg(not(target_os = "macos"))]
            folder_search::folder_search_closed,
            #[cfg(not(target_os = "macos"))]
            folder_search::folder_search_status,
            #[cfg(not(target_os = "macos"))]
            folder_search::folder_search_open_library
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Focused(true)) && window.label() == "main" {
                settings::follow_library_move(window.app_handle());
            }
            #[cfg(not(target_os = "macos"))]
            if matches!(event, tauri::WindowEvent::Focused(false)) && window.label() == "search" {
                folder_search::blurred(window.app_handle());
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                // Alt+F4 in the folder search only puts it away.
                if window.label() == "search" {
                    #[cfg(not(target_os = "macos"))]
                    folder_search::blurred(window.app_handle());
                } else if !window
                    .app_handle()
                    .try_state::<settings::SettingsState>()
                    .is_some_and(|s| s.0.try_lock().is_err())
                {
                    if cfg!(target_os = "macos")
                        || desktop_windows::floating_enabled(window.app_handle())
                    {
                        desktop_windows::hide(window.app_handle());
                    } else {
                        window.app_handle().exit(0);
                    }
                }
            }
            desktop_windows::window_event(window.app_handle(), window, event);
            #[cfg(target_os = "macos")]
            if window.label() == "main" {
                macos_window::refresh(window.app_handle());
            }
        })
        .on_menu_event(|app, event| {
            #[cfg(target_os = "macos")]
            macos_window::menu_event(app, event.id().as_ref());
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        })
        .setup(|app| {
            app.manage(settings::SettingsState(std::sync::Mutex::new(())));
            app.manage(reference_drag::ReferenceDragState::default());
            #[cfg(not(target_os = "macos"))]
            app.manage(folder_search::FolderSearchState::default());
            lifecycle::install_tray(app.handle())?;
            let library_state = library::LibraryState::new(app.handle())?;
            // Alternate bundle identities are isolated test products; they must
            // never become the production browser provider when its port frees.
            if app.config().identifier == "app.stashdock.desktop" {
                #[cfg(not(debug_assertions))]
                if std::env::var("STASHDOCK_NATIVE_HOST_REGISTRATION").as_deref() != Ok("off") {
                    let helper = if cfg!(target_os = "macos") {
                        std::env::current_exe().map(|p| p.with_file_name("stashdock-browser")).ok()
                    } else {
                        app.path().resource_dir().ok().map(|p| p.join("stashdock-browser.exe"))
                    };
                    if let Some(helper) = helper {
                        tauri::async_runtime::spawn_blocking(move || {
                            if let Err(error) = library::native_host::register("desktop", &helper, library::native_host::Registration::Replace) {
                                eprintln!("StashDock browser save component: {error}");
                            }
                        });
                    }
                }
                library::start_extension_server(
                    app.handle().clone(),
                    library_state.database_path().to_path_buf(),
                );
            }
            web_preview::start(
                app.handle().clone(),
                library_state.database_path().to_path_buf(),
            );
            let preferences = settings::read(&library_state)?;
            app.manage(library_state);
            #[cfg(target_os = "macos")]
            folder_window::install(app.handle()).map_err(std::io::Error::other)?;
            #[cfg(target_os = "macos")]
            folder_search_macos::install(app.handle());
            desktop_windows::initialize(app.handle()).map_err(std::io::Error::other)?;
            #[cfg(target_os = "macos")]
            macos_window::install(app.handle()).map_err(std::io::Error::other)?;
            if !preferences.shortcut.is_empty() {
                // A shortcut conflict must not make the whole application fail
                // to launch. Settings lets the user choose another shortcut.
                if let Err(error) = app
                    .global_shortcut()
                    .register(preferences.shortcut.as_str())
                {
                    eprintln!("StashDock shortcut: {error}");
                }
            }
            settings::update_tray(app.handle(), &preferences);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building StashDock")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                desktop_windows::show_panel(app);
            }
            if matches!(event, tauri::RunEvent::Exit) {
                folder_search::detach(app, true);
                desktop_windows::persist_now(app);
                web_preview::shutdown(app);
            }
        });
}
