//! Decides whether the currently focused control may be corrected.
//!
//! **Fail-closed.** We correct only where the process is explicitly allowlisted
//! *and* nothing suggests the control holds a secret. Silence is refusal: if we
//! cannot tell what we are typing into, we do not touch it.
//!
//! A denylist was considered and rejected — the set of editors that mangle
//! synthetic input is unbounded, so a denylist is wrong by default.
//!
//! # Known limit
//!
//! [`is_password_field`] reads the Win32 `ES_PASSWORD` style, which only exists for
//! native EDIT controls. Chromium, Electron and Java render their own text fields
//! and expose "this is a password" solely through UI Automation. Until the UIA
//! probe lands, **browsers must not be added to the shipped allowlist** — the
//! password check simply cannot see into them.

use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HWND, MAX_PATH, RPC_E_CHANGED_MODE};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::GetKeyboardLayout;
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetForegroundWindow, GetGUIThreadInfo, GetWindowLongW, GetWindowThreadProcessId,
    GUITHREADINFO, GWL_STYLE,
};

/// `ES_PASSWORD`, from winuser.h. Only meaningful on an EDIT-class window.
const ES_PASSWORD: i32 = 0x0020;

/// Combine the native and UI Automation password signals into one verdict.
///
/// `None` means "could not determine", which callers must treat as refusal — not
/// as permission. Pure so the policy is testable without a desktop.
///
/// Either source claiming "password" wins. They look at different things: the
/// Win32 style is authoritative for native EDIT controls but blind to
/// Chromium/Electron/Java, while UIA sees into those but is occasionally absent
/// or unresponsive. Neither alone is sufficient.
pub fn combine_password_signals(native: Option<bool>, uia: Option<bool>) -> Option<bool> {
    match (native, uia) {
        // Any positive is decisive — refuse.
        (Some(true), _) | (_, Some(true)) => Some(true),
        // A negative from either is good enough to proceed: a native EDIT control
        // without ES_PASSWORD is genuinely not a password box, and UIA reporting
        // IsPassword=false is the authoritative answer inside a browser.
        (Some(false), _) | (_, Some(false)) => Some(false),
        // Nobody could tell us. Silence is refusal.
        (None, None) => None,
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Target {
    /// Lowercased executable name, e.g. `winword.exe`. Empty if undeterminable.
    pub process: String,
    /// True only when we positively established the field is safe to type into.
    pub allowed: bool,
}

/// Inspect the foreground window and decide whether corrections may fire.
///
/// Called when focus may have moved, never per keystroke — `GetGUIThreadInfo`,
/// `QueryFullProcessImageNameW` and especially the UIA probe are cross-process
/// calls and far too expensive for the hook path.
///
/// `probe` is the UI Automation client, owned by the worker thread. Pass `None`
/// to skip UIA entirely; the result is then fail-closed for any app whose text
/// fields the Win32 style cannot see into.
pub fn current(allowlist: &[String], own_pid: u32, probe: Option<&UiaProbe>) -> Target {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return Target::default();
    }

    let mut pid = 0u32;
    let thread_id = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if thread_id == 0 || pid == 0 {
        return Target::default();
    }

    // Never observe ourselves: typing in R3write's own quick-edit prompt must not
    // be captured, and correcting our own textarea would fight React.
    if pid == own_pid {
        return Target::default();
    }

    let process = process_name(pid).unwrap_or_default();
    if process.is_empty() {
        return Target::default();
    }

    if !allowlist.iter().any(|a| a.eq_ignore_ascii_case(&process)) {
        return Target {
            process,
            allowed: false,
        };
    }

    // Only probe once we know the app is allowlisted — no reason to pay for a
    // cross-process UIA call in an app we would refuse anyway.
    let verdict = combine_password_signals(
        native_password_signal(thread_id),
        probe.and_then(|p| p.focused_is_password()),
    );

    Target {
        process,
        // `None` (could not determine) is refusal, not permission.
        allowed: verdict == Some(false),
    }
}

fn process_name(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; MAX_PATH as usize];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(handle);
        ok.ok()?;
        let full = String::from_utf16_lossy(&buf[..len as usize]);
        Some(
            full.rsplit(['\\', '/'])
                .next()
                .unwrap_or(&full)
                .to_lowercase(),
        )
    }
}

/// Password signal from the Win32 window style.
///
/// `Some(_)` only when the focused window is genuinely a native EDIT control, for
/// which `ES_PASSWORD` is authoritative. `None` everywhere else — crucially in
/// Chromium, Electron and Java, which draw their own text boxes inside a single
/// HWND and so look like "not an edit control" rather than "not a password".
///
/// Returning `None` there rather than `false` is the whole point: a confident
/// `false` from this function would have been a lie, and would have let us type
/// into a browser password box.
fn native_password_signal(thread_id: u32) -> Option<bool> {
    unsafe {
        let mut info = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        GetGUIThreadInfo(thread_id, &mut info).ok()?;
        let focus = info.hwndFocus;
        if focus.0.is_null() {
            return None;
        }
        // The ES_PASSWORD bit is only meaningful on an edit control; the same bit
        // means something else entirely on other window classes.
        if !is_edit_class(focus) {
            return None;
        }
        Some(GetWindowLongW(focus, GWL_STYLE) & ES_PASSWORD != 0)
    }
}

fn is_edit_class(hwnd: HWND) -> bool {
    unsafe {
        let mut buf = [0u16; 64];
        let len = GetClassNameW(hwnd, &mut buf);
        if len <= 0 {
            return false;
        }
        let class = String::from_utf16_lossy(&buf[..len as usize]).to_lowercase();
        class == "edit" || class.starts_with("richedit")
    }
}

/// UI Automation client for password-field detection.
///
/// This is what makes browsers and Electron apps supportable at all: they render
/// text boxes themselves inside one HWND, so the Win32 style cannot distinguish a
/// password field from a search box. UIA's `IsPassword` can.
///
/// # Threading
///
/// Not `Send`. COM is initialised on whichever thread constructs this, and the
/// interface pointer is only valid there — so the worker thread owns it for its
/// lifetime and nothing else touches it. It is deliberately never used from the
/// keyboard hook thread: `GetFocusedElement` is a cross-process call that can take
/// tens of milliseconds, and a hook callback that overruns `LowLevelHooksTimeout`
/// gets silently torn down by Windows.
pub struct UiaProbe {
    automation: IUIAutomation,
}

impl UiaProbe {
    /// Initialise COM (multithreaded apartment, as recommended for UIA clients)
    /// and create the automation object. Returns `None` if either fails — the
    /// caller then runs without UIA, which means browsers stay refused.
    pub fn new() -> Option<Self> {
        unsafe {
            // Already-initialised is fine and common — Tauri may have done it.
            // Any other failure means we go without.
            let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
            if hr.is_err() && hr != RPC_E_CHANGED_MODE {
                eprintln!("[r3write] CoInitializeEx failed for UIA: {hr:?}");
                return None;
            }
            match CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER) {
                Ok(automation) => Some(Self { automation }),
                Err(e) => {
                    eprintln!("[r3write] UI Automation unavailable: {e}");
                    None
                }
            }
        }
    }

    /// Whether the focused element is a password field.
    ///
    /// `None` means UIA could not answer — the app is unresponsive, refuses
    /// automation, or exposes nothing focusable. Callers must read that as
    /// refusal.
    pub fn focused_is_password(&self) -> Option<bool> {
        unsafe {
            let element = self.automation.GetFocusedElement().ok()?;
            element.CurrentIsPassword().ok().map(|b| b.as_bool())
        }
    }
}

/// Active keyboard layout / IME for the foreground thread, as an opaque handle.
///
/// A change here means the user switched language or started IME composition. The
/// character we predicted for a scan code is no longer the character that will
/// appear, so the buffer must be dropped. CJK composition in particular produces
/// text through a path the hook never sees.
pub fn current_layout() -> isize {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return 0;
        }
        let tid = GetWindowThreadProcessId(hwnd, None);
        GetKeyboardLayout(tid).0 as isize
    }
}

/// Parse the newline-separated allowlist from Settings into comparable names.
pub fn parse_allowlist(raw: &str) -> Vec<String> {
    raw.lines()
        .map(|l| l.trim().to_lowercase())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_parsing_ignores_blanks_and_comments() {
        let raw = "notepad.exe\n\n  WINWORD.EXE  \n# a comment\nCode.exe\n";
        assert_eq!(
            parse_allowlist(raw),
            vec!["notepad.exe", "winword.exe", "code.exe"]
        );
    }

    #[test]
    fn empty_allowlist_permits_nothing() {
        // Fail-closed: an empty list is "correct nowhere", never "correct everywhere".
        assert!(parse_allowlist("").is_empty());
    }

    // --- password policy -----------------------------------------------------
    //
    // `current()` gates on `verdict == Some(false)`, so anything other than a
    // definite "not a password" refuses. These pin that policy down.

    #[test]
    fn either_source_claiming_password_refuses() {
        assert_eq!(combine_password_signals(Some(true), None), Some(true));
        assert_eq!(combine_password_signals(None, Some(true)), Some(true));
        // Disagreement resolves toward refusal, never toward typing.
        assert_eq!(combine_password_signals(Some(false), Some(true)), Some(true));
        assert_eq!(combine_password_signals(Some(true), Some(false)), Some(true));
    }

    #[test]
    fn a_definite_negative_permits() {
        // Native EDIT control without ES_PASSWORD — e.g. Notepad.
        assert_eq!(combine_password_signals(Some(false), None), Some(false));
        // UIA inside a browser reporting IsPassword=false.
        assert_eq!(combine_password_signals(None, Some(false)), Some(false));
        assert_eq!(combine_password_signals(Some(false), Some(false)), Some(false));
    }

    #[test]
    fn silence_is_refusal_not_permission() {
        // This is the case that matters. Before UIA existed, a Chromium text box
        // produced no native signal, and reading that absence as "not a password"
        // is exactly how you end up typing into a password box.
        assert_eq!(combine_password_signals(None, None), None);
        assert_ne!(
            combine_password_signals(None, None),
            Some(false),
            "unknown must never be treated as safe"
        );
    }

    #[test]
    fn unknown_verdict_does_not_satisfy_the_gate() {
        // Mirrors the check in `current()`: allowed = verdict == Some(false).
        let allowed = |v: Option<bool>| v == Some(false);
        assert!(!allowed(combine_password_signals(None, None)));
        assert!(!allowed(combine_password_signals(Some(true), None)));
        assert!(allowed(combine_password_signals(None, Some(false))));
    }
}
