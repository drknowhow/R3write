//! PHASE 0 SPIKE — THROWAWAY. Delete once the matrix in the plan is recorded.
//!
//! This is not production code and must never be wired into the app. It exists to
//! answer one question before any UI, settings, or logging is built:
//!
//!     Does backspace-and-retype actually survive real Windows applications?
//!
//! Run it, then type `teh ` (with a trailing space) into each app in the matrix and
//! record what happened to the RESULTING TEXT and the UNDO STACK — not whether the
//! keystrokes were delivered. "Keys arrived" is the wrong pass criterion; every
//! interesting failure happens after delivery.
//!
//!     cargo run --example spike_hook
//!
//! Matrix (see plan): Word, Chrome (address bar + textarea), Slack, VS Code,
//! Notepad, Windows Terminal.
//!
//! Per app, answer:
//!   1. Is the final text exactly `the ` — or did something else land?
//!   2. Does ONE Ctrl+Z undo the whole correction, or does it split / strip extra?
//!   3. Did a completion popup eat the Backspace, or replace a wider range?
//!   4. Did the app's own transform (Word autocorrect, Slack markdown) fire on the
//!      delimiter BEFORE our backspaces landed?
//!   5. Non-ASCII: type `tehé ` and `teh👍 `. N chars != N backspaces for graphemes.
//!
//! GATE: if replacement is unreliable in more than one of Word / Chrome / Slack,
//! stop and re-plan. Apps that pass become the initial allowlist.

use std::sync::mpsc::{channel, Sender};
use std::sync::OnceLock;
use std::thread;

use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, MAPVK_VK_TO_CHAR, VIRTUAL_KEY, VK_BACK,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, SetWindowsHookExW, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG,
    WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
};

/// Stamped into every keystroke we synthesize so the hook can recognise its own
/// output. enigo offers no way to set dwExtraInfo, which is exactly why the real
/// `inject.rs` must use raw SendInput too — noted in the plan.
const R3W_INJECT_TAG: usize = 0x5233_5749; // "R3WI"

/// The one word this spike corrects. Hardcoded on purpose — the dictionary is
/// Phase 1's problem, and mixing it in here would muddy what is being tested.
const TRIGGER: &str = "teh";
const FIX: &str = "the";

#[derive(Debug)]
enum KeyEvent {
    /// A character the user actually typed.
    Char(char),
    /// A word delimiter — commits the buffer.
    Commit(char),
    /// Something that desyncs our shadow buffer from the real document.
    /// In the spike we only log it; Phase 1 turns this into the invalidation
    /// subsystem described in the plan.
    Invalidate(&'static str),
}

static SENDER: OnceLock<Sender<KeyEvent>> = OnceLock::new();

fn main() {
    eprintln!("[spike] R3write autocorrect Phase 0 spike");
    eprintln!("[spike] type `{TRIGGER} ` into a target app; it should become `{FIX} `");
    eprintln!("[spike] Ctrl+C here to quit\n");

    let (tx, rx) = channel::<KeyEvent>();
    SENDER
        .set(tx)
        .expect("sender set once before the hook is installed");

    // The worker owns all state. The hook thread does nothing but forward.
    thread::spawn(move || {
        let mut buffer = String::new();
        for ev in rx {
            match ev {
                KeyEvent::Char(c) => {
                    buffer.push(c);
                    if buffer.len() > 64 {
                        buffer.clear();
                    }
                }
                KeyEvent::Invalidate(why) => {
                    if !buffer.is_empty() {
                        eprintln!("[spike] buffer dropped ({why}): {buffer:?}");
                    }
                    buffer.clear();
                }
                KeyEvent::Commit(delim) => {
                    let word = std::mem::take(&mut buffer);
                    if word.is_empty() {
                        continue;
                    }
                    eprintln!("[spike] committed word: {word:?} (delim {delim:?})");
                    if word == TRIGGER {
                        // Count graphemes-as-chars here; the spike deliberately uses
                        // .chars() so the emoji/accent cases in the matrix can EXPOSE
                        // the difference rather than hide it behind a correct impl.
                        let backspaces = word.chars().count() + 1; // + the delimiter
                        eprintln!("[spike] correcting -> {FIX:?} ({backspaces} backspaces)");
                        if let Err(e) = replace(backspaces, &format!("{FIX}{delim}")) {
                            eprintln!("[spike] injection FAILED: {e}");
                        }
                    }
                }
            }
        }
    });

    // The LL hook must be installed on a thread that pumps messages, and this
    // thread must never block — Windows silently unhooks a callback that exceeds
    // LowLevelHooksTimeout (~300ms).
    unsafe {
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), None, 0)
            .expect("SetWindowsHookExW failed — are we running elevated against a lower-IL target?");
        eprintln!("[spike] hook installed: {hook:?}");

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
    }
}

/// Runs on the hook thread for EVERY keystroke system-wide. Does no allocation,
/// takes no locks, and returns immediately.
unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code < 0 {
        return CallNextHookEx(None, code, wparam, lparam);
    }

    let is_keydown = wparam.0 as u32 == WM_KEYDOWN || wparam.0 as u32 == WM_SYSKEYDOWN;
    if !is_keydown {
        return CallNextHookEx(None, code, wparam, lparam);
    }

    let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
    let injected = kb.flags.0 & LLKHF_INJECTED.0 != 0;

    if injected {
        if kb.dwExtraInfo == R3W_INJECT_TAG {
            // Ours. Drop unconditionally — this is what prevents the correction
            // from re-entering the buffer and looping.
            return CallNextHookEx(None, code, wparam, lparam);
        }
        // Injected by someone else (another automation tool, an on-screen
        // keyboard, a virtual HID). We did not type it and cannot model its
        // effect, so the buffer is no longer trustworthy.
        send(KeyEvent::Invalidate("foreign injected input"));
        return CallNextHookEx(None, code, wparam, lparam);
    }

    send(classify(kb.vkCode));
    CallNextHookEx(None, code, wparam, lparam)
}

/// Maps a virtual key to what it means for the shadow buffer.
///
/// Deliberately crude: MAPVK_VK_TO_CHAR rather than ToUnicode, because ToUnicode
/// mutates dead-key state inside a hook and would corrupt the very thing the
/// matrix is meant to measure. Phase 1 needs a real answer here.
unsafe fn classify(vk: u32) -> KeyEvent {
    use windows::Win32::UI::Input::KeyboardAndMouse as k;

    let vkey = VIRTUAL_KEY(vk as u16);
    match vkey {
        // Caret navigation — the document moved out from under us.
        k::VK_LEFT | k::VK_RIGHT | k::VK_UP | k::VK_DOWN | k::VK_HOME | k::VK_END
        | k::VK_PRIOR | k::VK_NEXT => KeyEvent::Invalidate("caret navigation"),

        k::VK_ESCAPE => KeyEvent::Invalidate("escape"),
        k::VK_BACK | k::VK_DELETE => KeyEvent::Invalidate("manual delete"),

        k::VK_SPACE => KeyEvent::Commit(' '),
        k::VK_RETURN => KeyEvent::Commit('\n'),
        k::VK_TAB => KeyEvent::Commit('\t'),

        _ => {
            // Any modifier combination is a shortcut, not typing. Ctrl+V / Ctrl+X /
            // Ctrl+Z in particular mutate the document invisibly to us.
            let ctrl = k::GetKeyState(k::VK_CONTROL.0 as i32) < 0;
            let alt = k::GetKeyState(k::VK_MENU.0 as i32) < 0;
            let win = k::GetKeyState(k::VK_LWIN.0 as i32) < 0
                || k::GetKeyState(k::VK_RWIN.0 as i32) < 0;
            if ctrl || alt || win {
                return KeyEvent::Invalidate("modifier shortcut");
            }

            let mapped = MapVirtualKeyW(vk, MAPVK_VK_TO_CHAR);
            match char::from_u32(mapped & 0x7FFF) {
                Some(c) if c.is_alphanumeric() || c == '\'' => {
                    KeyEvent::Char(c.to_ascii_lowercase())
                }
                Some(c) if c.is_ascii_punctuation() => KeyEvent::Commit(c),
                _ => KeyEvent::Invalidate("unmapped key"),
            }
        }
    }
}

fn send(ev: KeyEvent) {
    if let Some(tx) = SENDER.get() {
        // A full channel must never block the hook thread.
        let _ = tx.send(ev);
    }
}

/// Send `backspaces` backspaces, then type `text`. Every synthesized event carries
/// R3W_INJECT_TAG so our own hook ignores it.
///
/// enigo is NOT used here: it provides no way to set dwExtraInfo, so its output
/// would come back through the hook indistinguishable from a foreign tool's. The
/// real inject.rs has the same constraint.
fn replace(backspaces: usize, text: &str) -> Result<(), String> {
    let mut inputs: Vec<INPUT> = Vec::with_capacity(backspaces * 2 + text.len() * 2);

    for _ in 0..backspaces {
        inputs.push(key_input(VK_BACK, false));
        inputs.push(key_input(VK_BACK, true));
    }
    for unit in text.encode_utf16() {
        inputs.push(unicode_input(unit, false));
        inputs.push(unicode_input(unit, true));
    }

    // One atomic SendInput call: Windows delivers the whole batch without
    // interleaving real user keystrokes into the middle of it.
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        return Err(format!("SendInput sent {sent}/{}", inputs.len()));
    }
    Ok(())
}

fn key_input(vk: VIRTUAL_KEY, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { Default::default() },
                time: 0,
                dwExtraInfo: R3W_INJECT_TAG,
            },
        },
    }
}

fn unicode_input(unit: u16, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: unit,
                dwFlags: if up {
                    KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
                } else {
                    KEYEVENTF_UNICODE
                },
                time: 0,
                dwExtraInfo: R3W_INJECT_TAG,
            },
        },
    }
}
