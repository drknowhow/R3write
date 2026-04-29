#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, WindowEvent,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[derive(Default)]
struct OriginalClipboard(Mutex<Option<String>>);

const QUICK_EDIT_LABEL: &str = "quick-edit";
const MAIN_LABEL: &str = "main";
const CLIPBOARD_SENTINEL: &str = "\u{0001}r3write::no-selection\u{0001}";

fn main() {
    tauri::Builder::default()
        .manage(OriginalClipboard::default())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let app = app.clone();
                        thread::spawn(move || {
                            if let Err(e) = trigger_quick_edit(&app) {
                                eprintln!("[r3write] quick-edit trigger failed: {e}");
                            }
                        });
                    }
                })
                .build(),
        )
        .setup(|app| {
            let shortcut = Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::ALT),
                Code::KeyG,
            );
            match app.global_shortcut().register(shortcut) {
                Ok(_) => eprintln!("[r3write] registered Ctrl+Alt+G global shortcut"),
                Err(e) => eprintln!("[r3write] FAILED to register Ctrl+Alt+G: {e}"),
            }

            let show_item = MenuItem::with_id(app, "tray:show", "Show R3write", true, None::<&str>)?;
            let quick_item = MenuItem::with_id(
                app,
                "tray:quick",
                "Quick edit (Ctrl+Alt+G)",
                true,
                None::<&str>,
            )?;
            let quit_item = MenuItem::with_id(app, "tray:quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quick_item, &quit_item])?;

            let mut builder = TrayIconBuilder::with_id("r3write-tray")
                .tooltip("R3write")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray:show" => show_main(app),
                    "tray:quick" => {
                        let app_h = app.clone();
                        thread::spawn(move || {
                            if let Err(e) = trigger_quick_edit(&app_h) {
                                eprintln!("[r3write] tray quick-edit failed: {e}");
                            }
                        });
                    }
                    "tray:quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                builder = builder.icon(icon.clone());
            }
            builder.build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == MAIN_LABEL {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![accept_rewrite, dismiss_popup])
        .run(tauri::generate_context!())
        .expect("error while running R3write");
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn trigger_quick_edit(app: &AppHandle) -> Result<(), String> {
    // The user is still physically holding Ctrl+Alt from the hotkey when this
    // fires. If we send Ctrl+C now Windows sees Ctrl+Alt+C and the copy is a
    // no-op. Force-release the modifiers first, then wait for the OS to settle.
    {
        let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
        let _ = enigo.key(Key::Alt, Direction::Release);
        let _ = enigo.key(Key::Control, Direction::Release);
        let _ = enigo.key(Key::Shift, Direction::Release);
        let _ = enigo.key(Key::Meta, Direction::Release);
    }
    thread::sleep(Duration::from_millis(80));

    let original = app.clipboard().read_text().ok();
    *app.state::<OriginalClipboard>()
        .0
        .lock()
        .map_err(|e| e.to_string())? = original.clone();

    // Sentinel detects a no-op Ctrl+C: if nothing is selected the OS doesn't
    // touch the clipboard, so the sentinel survives. Without it we'd open the
    // popup against whatever stale text was last copied.
    let _ = app.clipboard().write_text(CLIPBOARD_SENTINEL.to_string());
    thread::sleep(Duration::from_millis(30));

    send_modifier_combo(Key::Control, Key::Unicode('c'))?;
    thread::sleep(Duration::from_millis(180));

    let raw = app.clipboard().read_text().unwrap_or_default();
    let captured = if raw == CLIPBOARD_SENTINEL { String::new() } else { raw };

    // Restore the original clipboard immediately so the user's clipboard is
    // never left holding the sentinel or the captured selection.
    match &original {
        Some(orig) => {
            let _ = app.clipboard().write_text(orig.clone());
        }
        None => {
            let _ = app.clipboard().write_text(String::new());
        }
    }

    eprintln!(
        "[r3write] quick-edit triggered (selection_len={})",
        captured.chars().count()
    );

    let (x, y) = cursor_position(app);
    if let Some(w) = app.get_webview_window(QUICK_EDIT_LABEL) {
        let _ = w.set_position(PhysicalPosition::new(x, y));
        let _ = w.show();
        let _ = w.set_focus();
        w.emit("captured-text", captured).map_err(|e| e.to_string())?;
    } else {
        eprintln!("[r3write] quick-edit window not found");
    }

    Ok(())
}

#[tauri::command]
fn accept_rewrite(
    app: AppHandle,
    text: String,
    state: tauri::State<OriginalClipboard>,
) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(QUICK_EDIT_LABEL) {
        let _ = w.hide();
    }
    // Let Windows hand focus back to the originating app.
    thread::sleep(Duration::from_millis(90));

    app.clipboard().write_text(text).map_err(|e| e.to_string())?;
    thread::sleep(Duration::from_millis(40));
    send_modifier_combo(Key::Control, Key::Unicode('v'))?;
    thread::sleep(Duration::from_millis(140));

    let original = state.0.lock().map_err(|e| e.to_string())?.clone();
    if let Some(orig) = original {
        let _ = app.clipboard().write_text(orig);
    }
    Ok(())
}

#[tauri::command]
fn dismiss_popup(app: AppHandle, state: tauri::State<OriginalClipboard>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(QUICK_EDIT_LABEL) {
        let _ = w.hide();
    }
    let original = state.0.lock().map_err(|e| e.to_string())?.clone();
    if let Some(orig) = original {
        let _ = app.clipboard().write_text(orig);
    }
    Ok(())
}

fn send_modifier_combo(modifier: Key, key: Key) -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    enigo.key(modifier, Direction::Press).map_err(|e| e.to_string())?;
    enigo.key(key, Direction::Click).map_err(|e| e.to_string())?;
    enigo.key(modifier, Direction::Release).map_err(|e| e.to_string())?;
    Ok(())
}

fn cursor_position(app: &AppHandle) -> (i32, i32) {
    if let Ok(pos) = app.cursor_position() {
        return (pos.x as i32, pos.y as i32);
    }
    (100, 100)
}
