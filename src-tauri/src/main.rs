#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[derive(Default)]
struct OriginalClipboard(Mutex<Option<String>>);

const QUICK_EDIT_LABEL: &str = "quick-edit";

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
            app.global_shortcut().register(shortcut)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![accept_rewrite, dismiss_popup])
        .run(tauri::generate_context!())
        .expect("error while running R3write");
}

fn trigger_quick_edit(app: &AppHandle) -> Result<(), String> {
    let original = app.clipboard().read_text().ok();
    *app.state::<OriginalClipboard>()
        .0
        .lock()
        .map_err(|e| e.to_string())? = original.clone();

    send_modifier_combo(Key::Control, Key::Unicode('c'))?;
    thread::sleep(Duration::from_millis(140));

    let captured = app.clipboard().read_text().unwrap_or_default();
    if captured.trim().is_empty() {
        if let Some(orig) = original {
            let _ = app.clipboard().write_text(orig);
        }
        return Ok(());
    }

    let (x, y) = cursor_position(app);
    if let Some(w) = app.get_webview_window(QUICK_EDIT_LABEL) {
        let _ = w.set_position(PhysicalPosition::new(x, y));
        let _ = w.show();
        let _ = w.set_focus();
        w.emit("captured-text", captured).map_err(|e| e.to_string())?;
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
