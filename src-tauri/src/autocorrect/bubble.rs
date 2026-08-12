//! The correction toast window.
//!
//! You cannot draw an underline inside another application's text field — R3write
//! has no access to Word's or Chrome's rendering, and a caret-anchored overlay
//! would need per-app accessibility integration plus scroll/resize tracking that
//! breaks in exactly the apps people use. So the marking is a small always-on-top
//! toast in the corner of the work area, plus a global undo hotkey.
//!
//! It must never steal focus: the user is mid-sentence in another app, and taking
//! focus would both interrupt them and send our own undo keystrokes to the wrong
//! window. Shown with `SW_SHOWNOACTIVATE`, same as the quick-edit popup.

use tauri::{AppHandle, Manager, PhysicalPosition};

pub const BUBBLE_LABEL: &str = "autocorrect-bubble";

/// Gap from the work-area edges, in physical pixels.
const MARGIN: i32 = 16;

/// Position the toast in the bottom-right of the *work area* and show it without
/// taking focus.
pub fn show(app: &AppHandle) {
    let Some(w) = app.get_webview_window(BUBBLE_LABEL) else {
        return;
    };

    if let Some((right, bottom)) = work_area_bottom_right() {
        // Use the real outer size rather than the configured logical size so the
        // placement survives display scaling.
        let (ww, wh) = w
            .outer_size()
            .map(|s| (s.width as i32, s.height as i32))
            .unwrap_or((340, 76));
        let _ = w.set_position(PhysicalPosition::new(
            right - ww - MARGIN,
            bottom - wh - MARGIN,
        ));
    }

    crate::show_no_activate(&w);
}

pub fn hide(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(BUBBLE_LABEL) {
        let _ = w.hide();
        // Tauri's hide() is unreliable on this flag combination (frameless +
        // topmost + skipTaskbar) — the same reason `accept_rewrite` needs it.
        crate::hide_native(&w);
    }
}

/// Bottom-right corner of the primary monitor's work area, in physical pixels.
///
/// The *work area*, not the monitor bounds: anchoring to the monitor would put the
/// toast underneath the taskbar.
#[cfg(windows)]
fn work_area_bottom_right() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPI_GETWORKAREA, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    };

    let mut rect = RECT::default();
    unsafe {
        SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            Some(&mut rect as *mut RECT as *mut std::ffi::c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
        .ok()?;
    }
    Some((rect.right, rect.bottom))
}

#[cfg(not(windows))]
fn work_area_bottom_right() -> Option<(i32, i32)> {
    None
}
