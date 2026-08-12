#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, WindowEvent,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_shell::ShellExt;
use windows::Win32::UI::Input::KeyboardAndMouse::{VK_C, VK_CONTROL, VK_V};

#[derive(Default)]
struct OriginalClipboard(Mutex<Option<String>>);

struct CurrentHotkey(Mutex<Shortcut>);
struct RepeatHotkey(Mutex<Shortcut>);
/// Reverts the last autocorrect. Separate from the rewrite hotkeys because it is
/// meaningful even when the quick-edit popup has never been opened.
struct UndoHotkey(Mutex<Shortcut>);

pub fn default_undo_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyZ)
}

/// Claim or release the autocorrect undo shortcut.
///
/// Called from `autocorrect::apply` so the shortcut's lifetime matches the
/// feature's: enabled means we hold Ctrl+Alt+Z, disabled means we give it back to
/// whatever else the user has bound it to.
pub fn set_undo_shortcut_registered(app: &AppHandle, want: bool) {
    let sc = default_undo_shortcut();

    // If the user has bound their own hotkey to this combination, it is theirs, not
    // ours: never register over it and — more importantly — never UNREGISTER it.
    // Doing so killed their quick-edit hotkey outright until the app restarted,
    // simply because autocorrect had been toggled off.
    let collides = |state: Option<Shortcut>| state.is_some_and(|s| s == sc);
    let main_hotkey = app.state::<CurrentHotkey>().0.lock().ok().map(|g| *g);
    let repeat_hotkey = app.state::<RepeatHotkey>().0.lock().ok().map(|g| *g);
    if collides(main_hotkey) || collides(repeat_hotkey) {
        eprintln!("[r3write] undo shortcut collides with the user's hotkey — leaving it alone");
        return;
    }

    let held = app.global_shortcut().is_registered(sc);
    if want && !held {
        match app.global_shortcut().register(sc) {
            Ok(_) => eprintln!("[r3write] registered Ctrl+Alt+Z (autocorrect undo)"),
            Err(e) => eprintln!("[r3write] undo shortcut register failed: {e}"),
        }
    } else if !want && held {
        let _ = app.global_shortcut().unregister(sc);
    }
}

fn default_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyG)
}

fn repeat_shortcut_for(base: &Shortcut) -> Shortcut {
    // Repeat fires the same key with the SHIFT modifier added on top of
    // whatever the main hotkey carries. We never want a base shortcut that
    // already has Shift set — `set_hotkey` enforces that on the JS side.
    let mods = base.mods | Modifiers::SHIFT;
    Shortcut::new(Some(mods), base.key)
}

mod autocorrect;

const QUICK_EDIT_LABEL: &str = "quick-edit";
const MAIN_LABEL: &str = "main";
const CLIPBOARD_SENTINEL: &str = "\u{0001}r3write::no-selection\u{0001}";

fn main() {
    tauri::Builder::default()
        .manage(OriginalClipboard::default())
        .manage(autocorrect::AutocorrectState::default())
        .manage(CurrentHotkey(Mutex::new(default_shortcut())))
        .manage(RepeatHotkey(Mutex::new(repeat_shortcut_for(
            &default_shortcut(),
        ))))
        .manage(UndoHotkey(Mutex::new(default_undo_shortcut())))
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let current = app
                        .state::<CurrentHotkey>()
                        .0
                        .lock()
                        .ok()
                        .map(|g| g.clone());
                    let repeat = app
                        .state::<RepeatHotkey>()
                        .0
                        .lock()
                        .ok()
                        .map(|g| g.clone());
                    // The user's own hotkeys are matched FIRST. The undo shortcut is
                    // a fixed default the user never chose, so if they have bound
                    // the quick-edit hotkey to the same combination, theirs wins —
                    // checking undo first silently swallowed their main hotkey and
                    // the popup simply stopped opening.
                    let is_repeat = repeat.as_ref().is_some_and(|r| r == shortcut);
                    let is_main = current.as_ref().is_some_and(|c| c == shortcut);

                    if !is_repeat && !is_main {
                        let undo = app.state::<UndoHotkey>().0.lock().ok().map(|g| *g);
                        if undo.as_ref().is_some_and(|u| u == shortcut) {
                            // Undo does its own hide-and-settle before injecting, so
                            // it must not run on the shortcut handler's thread.
                            let app = app.clone();
                            thread::spawn(move || {
                                let state = app.state::<autocorrect::AutocorrectState>();
                                match autocorrect::autocorrect_undo_last(app.clone(), state) {
                                    Ok(true) => eprintln!("[r3write] autocorrect reverted"),
                                    // Nothing pending is the normal case, not an
                                    // error: the user has typed on since.
                                    Ok(false) => {}
                                    Err(e) => eprintln!("[r3write] autocorrect undo failed: {e}"),
                                }
                            });
                        }
                        return;
                    }
                    let app = app.clone();
                    thread::spawn(move || {
                        if let Err(e) = trigger_quick_edit(&app, is_repeat) {
                            eprintln!("[r3write] quick-edit trigger failed: {e}");
                        }
                    });
                })
                .build(),
        )
        .setup(|app| {
            let shortcut = default_shortcut();
            match app.global_shortcut().register(shortcut) {
                Ok(_) => eprintln!("[r3write] registered Ctrl+Alt+G global shortcut"),
                Err(e) => eprintln!("[r3write] FAILED to register Ctrl+Alt+G: {e}"),
            }
            let repeat = repeat_shortcut_for(&shortcut);
            match app.global_shortcut().register(repeat) {
                Ok(_) => eprintln!("[r3write] registered Ctrl+Alt+Shift+G (repeat)"),
                Err(e) => eprintln!("[r3write] repeat shortcut register failed: {e}"),
            }

            // NOT registered here. The undo shortcut is claimed only while
            // autocorrect is actually on (see `autocorrect::apply`) — a global
            // shortcut is a system-wide resource, and holding Ctrl+Alt+Z hostage
            // for a feature the user never enabled would break it in whatever app
            // they already use it for.

            let show_item = MenuItem::with_id(app, "tray:show", "Show R3write", true, None::<&str>)?;
            let bmc_item = MenuItem::with_id(
                app,
                "tray:bmc",
                "Support · Buy me a coffee",
                true,
                None::<&str>,
            )?;
            let sponsors_item = MenuItem::with_id(
                app,
                "tray:sponsors",
                "Support · Sponsor on GitHub",
                true,
                None::<&str>,
            )?;
            let quit_item = MenuItem::with_id(app, "tray:quit", "Quit", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(
                app,
                &[
                    &show_item,
                    &sep1,
                    &bmc_item,
                    &sponsors_item,
                    &sep2,
                    &quit_item,
                ],
            )?;

            let mut builder = TrayIconBuilder::with_id("r3write-tray")
                .tooltip("R3write")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray:show" => show_main(app),
                    "tray:bmc" => {
                        if let Err(e) = app
                            .shell()
                            .open("https://buymeacoffee.com/drknowhow", None)
                        {
                            eprintln!("[r3write] open BMC from tray failed: {e}");
                        }
                    }
                    "tray:sponsors" => {
                        if let Err(e) = app
                            .shell()
                            .open("https://github.com/sponsors/drknowhow", None)
                        {
                            eprintln!("[r3write] open Sponsors from tray failed: {e}");
                        }
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

            // Loads the persisted correction log only. The keyboard hook stays
            // uninstalled until the frontend both confirms an active license and
            // pushes a config with `enabled: true`.
            autocorrect::init(app.handle());

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
        .invoke_handler(tauri::generate_handler![
            accept_rewrite,
            dismiss_popup,
            set_hotkey,
            set_clipboard,
            autostart_set,
            autostart_get,
            secret_set,
            secret_get,
            secret_delete,
            autocorrect::autocorrect_set_config,
            autocorrect::autocorrect_get_config,
            autocorrect::autocorrect_set_license_active,
            autocorrect::autocorrect_status,
            autocorrect::autocorrect_get_log,
            autocorrect::autocorrect_clear_log,
            autocorrect::autocorrect_undo_last,
            autocorrect::autocorrect_installer_opt_in,
            autocorrect::autocorrect_dismiss_bubble,
            autocorrect::autocorrect_llm_suggestion,
            autocorrect::autocorrect_accept_suggestion,
        ])
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

// New capture flow: show the popup first (without grabbing focus) so the user
// gets immediate visual feedback that the hotkey was received, then run the
// clipboard dance in a background thread. The popup renders a "Capturing…"
// state on receipt of the `capture-start` event, and swaps in the real text
// once `captured-text` / `captured-text-repeat` arrives.
fn trigger_quick_edit(app: &AppHandle, repeat: bool) -> Result<(), String> {
    let (x, y) = cursor_position(app);
    if let Some(w) = app.get_webview_window(QUICK_EDIT_LABEL) {
        let _ = w.set_position(PhysicalPosition::new(x, y));
        // Show without activating — Tauri's `.show()` calls ShowWindow(SW_SHOW)
        // on Windows, which steals focus from the source app. If focus moves
        // before the capture thread sends Ctrl+C, the copy lands in our own
        // webview instead of the user's selection and the popup opens empty.
        // The capture thread calls `set_focus()` once capture finishes.
        show_no_activate(&w);
        let _ = w.emit("capture-start", repeat);
    } else {
        eprintln!("[r3write] quick-edit window not found");
        return Ok(());
    }

    let app_handle = app.clone();
    thread::spawn(move || {
        let captured = capture_selection(&app_handle).unwrap_or_default();
        eprintln!(
            "[r3write] quick-edit captured (repeat={repeat}, selection_len={})",
            captured.chars().count()
        );
        // Hand back to the GUI thread for the focus dance + event emit. The
        // GUI thread owns the popup HWND, and Windows' foreground rules are
        // far more lenient when SetForegroundWindow is called from the window
        // owner's thread than from a worker thread.
        let app_for_main = app_handle.clone();
        let dispatch = app_handle.run_on_main_thread(move || {
            if let Some(w) = app_for_main.get_webview_window(QUICK_EDIT_LABEL) {
                force_focus(&w);
                let event = if repeat { "captured-text-repeat" } else { "captured-text" };
                let _ = w.emit(event, captured);
            }
        });
        if let Err(e) = dispatch {
            eprintln!("[r3write] run_on_main_thread failed: {e}");
        }
    });

    Ok(())
}

// Blocking clipboard capture. Releases physically-held modifiers, sends
// Ctrl+C, then polls the clipboard until the sentinel is replaced (selection
// landed) or a short timeout expires (selection was empty). Restores the
// previous clipboard before returning.
fn capture_selection(app: &AppHandle) -> Result<String, String> {
    // The user is still physically holding the modifiers from the hotkey.
    // If we send Ctrl+C now, Windows sees the held Alt and the copy is a
    // no-op. Force-release the modifiers and wait briefly for the OS to settle.
    autocorrect::inject::release_modifiers()?;
    thread::sleep(Duration::from_millis(60));

    let original = app.clipboard().read_text().ok();
    *app.state::<OriginalClipboard>()
        .0
        .lock()
        .map_err(|e| e.to_string())? = original.clone();

    // Sentinel: if nothing is selected the OS doesn't touch the clipboard,
    // so the sentinel survives the Ctrl+C round-trip and we know to treat
    // the capture as empty.
    let _ = app.clipboard().write_text(CLIPBOARD_SENTINEL.to_string());
    thread::sleep(Duration::from_millis(20));

    autocorrect::inject::modifier_combo(VK_CONTROL, VK_C)?;

    // Poll the clipboard for change instead of sleeping a fixed amount. On a
    // fast machine this returns in ~10ms (the OS finishes the copy quickly);
    // on a laggy app (Office, Electron) it waits the full budget. Max wait
    // ~220ms — tighter than the prior fixed 180ms in the happy path.
    let captured = {
        let mut waited = 0u64;
        let current = loop {
            let now = app.clipboard().read_text().unwrap_or_default();
            if now != CLIPBOARD_SENTINEL {
                break now;
            }
            if waited >= 220 {
                break String::new();
            }
            thread::sleep(Duration::from_millis(10));
            waited += 10;
        };
        current
    };

    // Restore the original clipboard so the user is never left with the
    // sentinel (or the captured selection) hanging around.
    match &original {
        Some(orig) => {
            let _ = app.clipboard().write_text(orig.clone());
        }
        None => {
            let _ = app.clipboard().write_text(String::new());
        }
    }

    Ok(captured)
}

#[tauri::command]
fn accept_rewrite(
    app: AppHandle,
    text: String,
    state: tauri::State<OriginalClipboard>,
) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(QUICK_EDIT_LABEL) {
        let _ = w.hide();
        // Tauri's hide() is unreliable on this window's flag combination
        // (frameless + topmost + skipTaskbar); follow up with a direct
        // ShowWindow(SW_HIDE) so focus actually leaves the popup before
        // Windows hands it back to the originating app.
        hide_native(&w);
    }
    // Let Windows hand focus back to the originating app.
    thread::sleep(Duration::from_millis(90));

    app.clipboard().write_text(text).map_err(|e| e.to_string())?;
    thread::sleep(Duration::from_millis(40));
    autocorrect::inject::modifier_combo(VK_CONTROL, VK_V)?;
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
        // Tauri 2's WebviewWindow::hide() returns Ok(()) but does not
        // actually hide a window with this flag combination (decorations:
        // false + alwaysOnTop + skipTaskbar) — is_visible() stays true.
        // Follow up with a direct ShowWindow(SW_HIDE) as the real hide.
        let _ = w.hide();
        hide_native(&w);
    }
    let original = state.0.lock().map_err(|e| e.to_string())?.clone();
    if let Some(orig) = original {
        let _ = app.clipboard().write_text(orig);
    }
    Ok(())
}

#[cfg(windows)]
fn hide_native(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
}

#[cfg(not(windows))]
fn hide_native(_window: &tauri::WebviewWindow) {}

// Plain clipboard write — used by the main window's revert flow to put the
// pre-rewrite text back on the user's clipboard so they can paste it over
// the rewrite in the source app.
#[tauri::command]
fn set_clipboard(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

// `send_modifier_combo` used to live here and drive enigo directly. It now routes
// through `autocorrect::inject`, which stamps every event with R3W_INJECT_TAG.
//
// This is not cosmetic. enigo offers no way to set `dwExtraInfo`, so with the
// keyboard hook installed the Ctrl+C above and the Ctrl+V in `accept_rewrite`
// would come back through the hook indistinguishable from the user typing — the
// quick-edit paste would feed itself into the autocorrect buffer.

fn cursor_position(app: &AppHandle) -> (i32, i32) {
    if let Ok(pos) = app.cursor_position() {
        return (pos.x as i32, pos.y as i32);
    }
    (100, 100)
}

#[cfg(windows)]
fn show_no_activate(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
    if let Ok(hwnd) = window.hwnd() {
        // Safety: hwnd is a valid window handle owned by Tauri for the
        // lifetime of the WebviewWindow we just queried.
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
    } else {
        let _ = window.show();
    }
}

#[cfg(not(windows))]
fn show_no_activate(window: &tauri::WebviewWindow) {
    let _ = window.show();
}

// Reliably foreground the popup after capture finishes. `WebviewWindow::set_focus`
// resolves to `SetForegroundWindow`, which Windows silently refuses when the
// caller doesn't hold the foreground lock — exactly our situation, since the
// source app was foreground during capture. Without this the popup paints with
// the captured text but never receives keyboard focus, so Enter/Escape go to
// the source app and the user is stuck clicking on the popup before they can
// type. The standard workaround is to AttachThreadInput to the current
// foreground thread's input queue, then call SetForegroundWindow.
#[cfg(windows)]
fn force_focus(window: &tauri::WebviewWindow) {
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
        ShowWindow, SW_SHOW,
    };
    let Ok(hwnd) = window.hwnd() else {
        let _ = window.set_focus();
        return;
    };
    unsafe {
        // The popup was shown with SW_SHOWNOACTIVATE in trigger_quick_edit;
        // promote it to active now that capture has finished.
        let _ = ShowWindow(hwnd, SW_SHOW);

        let foreground = GetForegroundWindow();
        let foreground_tid = GetWindowThreadProcessId(foreground, None);
        let our_tid = GetCurrentThreadId();
        let attached = foreground_tid != 0
            && foreground_tid != our_tid
            && AttachThreadInput(foreground_tid, our_tid, true).as_bool();
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
        if attached {
            let _ = AttachThreadInput(foreground_tid, our_tid, false);
        }
    }
    // Tauri's set_focus also pushes WM_SETFOCUS through TAO so the WebView2
    // child window picks up keyboard focus, not just the outer Tauri parent.
    let _ = window.set_focus();
}

#[cfg(not(windows))]
fn force_focus(window: &tauri::WebviewWindow) {
    let _ = window.set_focus();
}

fn parse_code(s: &str) -> Option<Code> {
    use Code::*;
    match s {
        "KeyA" => Some(KeyA), "KeyB" => Some(KeyB), "KeyC" => Some(KeyC),
        "KeyD" => Some(KeyD), "KeyE" => Some(KeyE), "KeyF" => Some(KeyF),
        "KeyG" => Some(KeyG), "KeyH" => Some(KeyH), "KeyI" => Some(KeyI),
        "KeyJ" => Some(KeyJ), "KeyK" => Some(KeyK), "KeyL" => Some(KeyL),
        "KeyM" => Some(KeyM), "KeyN" => Some(KeyN), "KeyO" => Some(KeyO),
        "KeyP" => Some(KeyP), "KeyQ" => Some(KeyQ), "KeyR" => Some(KeyR),
        "KeyS" => Some(KeyS), "KeyT" => Some(KeyT), "KeyU" => Some(KeyU),
        "KeyV" => Some(KeyV), "KeyW" => Some(KeyW), "KeyX" => Some(KeyX),
        "KeyY" => Some(KeyY), "KeyZ" => Some(KeyZ),
        "Digit0" => Some(Digit0), "Digit1" => Some(Digit1), "Digit2" => Some(Digit2),
        "Digit3" => Some(Digit3), "Digit4" => Some(Digit4), "Digit5" => Some(Digit5),
        "Digit6" => Some(Digit6), "Digit7" => Some(Digit7), "Digit8" => Some(Digit8),
        "Digit9" => Some(Digit9),
        "F1" => Some(F1), "F2" => Some(F2), "F3" => Some(F3), "F4" => Some(F4),
        "F5" => Some(F5), "F6" => Some(F6), "F7" => Some(F7), "F8" => Some(F8),
        "F9" => Some(F9), "F10" => Some(F10), "F11" => Some(F11), "F12" => Some(F12),
        "Space" => Some(Space),
        "Tab" => Some(Tab),
        "Enter" => Some(Enter),
        "Backspace" => Some(Backspace),
        "ArrowUp" => Some(ArrowUp),
        "ArrowDown" => Some(ArrowDown),
        "ArrowLeft" => Some(ArrowLeft),
        "ArrowRight" => Some(ArrowRight),
        "Comma" => Some(Comma),
        "Period" => Some(Period),
        "Slash" => Some(Slash),
        "Backquote" => Some(Backquote),
        "Minus" => Some(Minus),
        "Equal" => Some(Equal),
        "Semicolon" => Some(Semicolon),
        "Quote" => Some(Quote),
        "BracketLeft" => Some(BracketLeft),
        "BracketRight" => Some(BracketRight),
        "Backslash" => Some(Backslash),
        _ => None,
    }
}

#[tauri::command]
fn set_hotkey(
    app: AppHandle,
    state: tauri::State<CurrentHotkey>,
    repeat_state: tauri::State<RepeatHotkey>,
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
    code: String,
) -> Result<(), String> {
    let mut mods = Modifiers::empty();
    if ctrl { mods |= Modifiers::CONTROL; }
    if alt { mods |= Modifiers::ALT; }
    if shift { mods |= Modifiers::SHIFT; }
    if meta { mods |= Modifiers::META; }
    if mods.is_empty() {
        return Err("At least one modifier (Ctrl, Alt, Shift, Win) is required.".into());
    }
    if shift {
        return Err(
            "The main hotkey can't use Shift — Shift is reserved for the repeat-last-action variant.".into(),
        );
    }
    let key = parse_code(&code).ok_or_else(|| format!("Unsupported key: {code}"))?;
    let next = Shortcut::new(Some(mods), key);
    let next_repeat = repeat_shortcut_for(&next);

    let prev = state.0.lock().map_err(|e| e.to_string())?.clone();
    let prev_repeat = repeat_state.0.lock().map_err(|e| e.to_string())?.clone();
    if next == prev {
        return Ok(());
    }
    let gs = app.global_shortcut();
    if let Err(e) = gs.unregister(prev.clone()) {
        eprintln!("[r3write] unregister prev failed: {e}");
    }
    if let Err(e) = gs.unregister(prev_repeat.clone()) {
        eprintln!("[r3write] unregister prev repeat failed: {e}");
    }
    match gs.register(next.clone()) {
        Ok(()) => {
            *state.0.lock().map_err(|e| e.to_string())? = next;
            if let Err(e) = gs.register(next_repeat.clone()) {
                eprintln!("[r3write] register repeat failed: {e}");
            } else {
                *repeat_state.0.lock().map_err(|e| e.to_string())? = next_repeat;
            }
            eprintln!("[r3write] hotkey rebound to {code} (mods: c={ctrl} a={alt} s={shift} m={meta})");
            Ok(())
        }
        Err(e) => {
            let _ = gs.register(prev);
            let _ = gs.register(prev_repeat);
            Err(format!("Could not bind {code}: {e}"))
        }
    }
}

// Autostart on Windows is wired through the per-user Run registry key. This
// is the same mechanism Tauri's autostart plugin uses on Windows, kept inline
// here to avoid pulling in another plugin + capability.
#[cfg(windows)]
fn autostart_apply(enable: bool) -> Result<(), String> {
    use std::process::Command;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.to_string_lossy();
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    let name = "R3write";
    let status = if enable {
        Command::new("reg")
            .args([
                "add", key, "/v", name, "/t", "REG_SZ", "/d", &format!("\"{exe}\""), "/f",
            ])
            .status()
            .map_err(|e| e.to_string())?
    } else {
        // Tolerate "value not found" — treat as success.
        Command::new("reg")
            .args(["delete", key, "/v", name, "/f"])
            .status()
            .map_err(|e| e.to_string())?
    };
    if !status.success() && enable {
        return Err(format!("reg add exited with {status}"));
    }
    Ok(())
}

#[cfg(windows)]
fn autostart_query() -> Result<bool, String> {
    use std::process::Command;
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    let out = Command::new("reg")
        .args(["query", key, "/v", "R3write"])
        .output()
        .map_err(|e| e.to_string())?;
    Ok(out.status.success())
}

#[cfg(not(windows))]
fn autostart_apply(_enable: bool) -> Result<(), String> {
    Err("Autostart is currently only implemented on Windows.".into())
}

#[cfg(not(windows))]
fn autostart_query() -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
fn autostart_set(enable: bool) -> Result<(), String> {
    autostart_apply(enable)
}

#[tauri::command]
fn autostart_get() -> Result<bool, String> {
    autostart_query()
}

const KEYRING_SERVICE: &str = "R3write";

#[tauri::command]
fn secret_set(name: String, value: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &name).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_get(name: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &name).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secret_delete(name: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &name).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
