//! The low-level keyboard and mouse hooks.
//!
//! `WH_KEYBOARD_LL` runs its callback on the installing thread for *every*
//! keystroke system-wide, and that thread must pump messages. The callback here
//! does exactly one thing — classify and forward — because Windows silently
//! unhooks a callback that overruns `LowLevelHooksTimeout` (~300ms by default) and
//! gives no error when it does. No allocation, no locks, no I/O, ever.
//!
//! # Reading modifier state from a hook
//!
//! `GetKeyState` must NOT be used here. It reports the *calling thread's* view of
//! the keyboard, which is synchronised from that thread's input queue — and the
//! pump thread below never receives keyboard input, so its view is permanently
//! empty. Ctrl+V would classify as typing `v`. `GetAsyncKeyState` reads the real
//! physical state and is what a hook has to use.

use std::sync::atomic::{AtomicIsize, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Mutex, OnceLock};
use std::thread::{self, JoinHandle};

use windows::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, ToUnicodeEx, HKL, VK_CAPITAL, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN,
    VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, GetWindowThreadProcessId, PostThreadMessageW, SetWindowsHookExW,
    UnhookWindowsHookEx, WindowFromPoint, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, MSLLHOOKSTRUCT,
    WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_QUIT,
    WM_RBUTTONDOWN, WM_SYSKEYDOWN, WM_XBUTTONDOWN,
};

use super::buffer::{classify, KeyEvent, Modifiers, Reason};
use super::inject::R3W_INJECT_TAG;

/// Created once and reused for the process lifetime. Enable/disable installs and
/// removes the hooks; it never swaps the channel, so the callback can read this
/// without locking.
static KEY_TX: OnceLock<SyncSender<KeyEvent>> = OnceLock::new();

/// Owns the pump thread. Holding the `JoinHandle` here — rather than inferring
/// "installed" from a raw handle atomic — is what makes install/uninstall safe to
/// interleave: the lock serialises them, and `uninstall` *joins* rather than
/// posting and hoping.
///
/// The previous shape let a disable-then-enable cycle race its own teardown: the
/// outgoing pump thread would zero the handle atomics *after* the incoming thread
/// had stored its own, leaving a live system-wide keyboard hook that `uninstall`
/// could no longer find. That hook then kept capturing keystrokes for the rest of
/// the process lifetime, including after the user switched autocorrect off.
static PUMP: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);

/// Live hook handles + pump thread id. Written only by the pump thread, and only
/// while `PUMP` is held by the installer, so they are never contended.
static HOOK: AtomicIsize = AtomicIsize::new(0);
static MOUSE_HOOK: AtomicIsize = AtomicIsize::new(0);
static HOOK_THREAD: AtomicU32 = AtomicU32::new(0);

/// Our own process id, so the mouse hook can ignore clicks on our own windows.
static OWN_PID: AtomicU32 = AtomicU32::new(0);

/// Active keyboard layout, published by the worker. The hook needs it to translate
/// scan codes but must not call `GetForegroundWindow`/`GetKeyboardLayout` itself on
/// every keystroke.
static LAYOUT: AtomicIsize = AtomicIsize::new(0);

/// Incremented for every event forwarded to the worker.
///
/// The worker snapshots this when a word commits and re-checks it immediately
/// before injecting. If anything arrived in between, the user typed on while we
/// were deciding and the backspace count no longer describes the screen.
static EVENT_SEQ: AtomicU64 = AtomicU64::new(0);

pub fn event_seq() -> u64 {
    EVENT_SEQ.load(Ordering::SeqCst)
}

pub fn set_layout(hkl: isize) {
    LAYOUT.store(hkl, Ordering::Relaxed);
}

/// Publish the channel the hooks forward to. Call once, before the first install.
pub fn set_sender(tx: SyncSender<KeyEvent>) {
    let _ = KEY_TX.set(tx);
    OWN_PID.store(std::process::id(), Ordering::SeqCst);
}

pub fn is_installed() -> bool {
    PUMP.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// Install the hooks on a dedicated message-pumping thread.
///
/// Blocks until the hook is confirmed installed (or failed), so callers report a
/// real result rather than an optimistic one.
pub fn install() -> Result<(), String> {
    let mut pump = PUMP.lock().map_err(|_| "hook lifecycle poisoned")?;
    if pump.is_some() {
        return Ok(());
    }
    if KEY_TX.get().is_none() {
        return Err("autocorrect channel not initialised".into());
    }

    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    let handle = thread::Builder::new()
        .name("r3write-kbd-hook".into())
        .spawn(move || unsafe {
            let hook = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), None, 0) {
                Ok(h) => h,
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("SetWindowsHookExW failed: {e}")));
                    return;
                }
            };
            HOOK.store(hook.0 as isize, Ordering::SeqCst);
            HOOK_THREAD.store(
                windows::Win32::System::Threading::GetCurrentThreadId(),
                Ordering::SeqCst,
            );

            // A mouse click repositions the caret with no keyboard event at all —
            // the most common way the shadow buffer silently desyncs.
            let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), None, 0).ok();
            if let Some(m) = mouse {
                MOUSE_HOOK.store(m.0 as isize, Ordering::SeqCst);
            } else {
                eprintln!(
                    "[r3write] mouse hook failed to install — caret moves via click will not invalidate"
                );
            }
            let _ = ready_tx.send(Ok(()));

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {}

            if let Some(m) = mouse {
                let _ = UnhookWindowsHookEx(m);
            }
            MOUSE_HOOK.store(0, Ordering::SeqCst);
            let _ = UnhookWindowsHookEx(hook);
            HOOK.store(0, Ordering::SeqCst);
            HOOK_THREAD.store(0, Ordering::SeqCst);
            eprintln!("[r3write] autocorrect hooks removed");
        })
        .map_err(|e| format!("hook thread spawn failed: {e}"))?;

    match ready_rx.recv() {
        Ok(Ok(())) => {
            *pump = Some(handle);
            Ok(())
        }
        Ok(Err(e)) => {
            let _ = handle.join();
            Err(e)
        }
        Err(_) => {
            let _ = handle.join();
            Err("hook thread died during install".into())
        }
    }
}

/// Remove the hooks and wait for the pump thread to actually exit.
///
/// Synchronous on purpose. Returning before teardown completes is what allowed a
/// fast disable/enable cycle to strand a live hook.
pub fn uninstall() {
    let Ok(mut pump) = PUMP.lock() else { return };
    let Some(handle) = pump.take() else { return };

    let tid = HOOK_THREAD.load(Ordering::SeqCst);
    if tid != 0 {
        unsafe {
            let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
    let _ = handle.join();
}

/// Runs on the hook thread for every keystroke on the system.
unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // Negative codes must be passed straight through without inspection.
    if code < 0 {
        return CallNextHookEx(None, code, wparam, lparam);
    }

    let msg = wparam.0 as u32;
    if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
        let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        if let Some(ev) = interpret(kb) {
            forward(ev);
        }
    }

    CallNextHookEx(None, code, wparam, lparam)
}

/// Mouse hook. Any button press means the caret may have moved somewhere we cannot
/// see, so the buffer is dropped. Movement alone is ignored — it is harmless and
/// firing on every mouse move would flood the queue.
unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let msg = wparam.0 as u32;
        if matches!(
            msg,
            WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN
        ) {
            let ms = &*(lparam.0 as *const MSLLHOOKSTRUCT);
            // Clicks on our OWN windows must not invalidate anything.
            //
            // The correction toast is the case that matters: this hook sees
            // WM_LBUTTONDOWN before the webview does, so an unfiltered invalidate
            // would retire the pending undo milliseconds before React's onClick
            // fired — making the toast's own Undo button silently dead on every
            // single click. Clicking our UI is also simply not evidence that the
            // user's caret moved in some other application.
            if !is_own_window(ms.pt) {
                forward(KeyEvent::Invalidate(Reason::MouseActivity));
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// Whether a screen point lies over a window belonging to this process.
///
/// Two cheap, in-process Win32 calls — safe for a hook callback.
unsafe fn is_own_window(pt: POINT) -> bool {
    let hwnd = WindowFromPoint(pt);
    if hwnd.0.is_null() {
        return false;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    pid != 0 && pid == OWN_PID.load(Ordering::SeqCst)
}

fn forward(ev: KeyEvent) {
    EVENT_SEQ.fetch_add(1, Ordering::SeqCst);
    if let Some(tx) = KEY_TX.get() {
        // try_send, never send: a full queue must never stall the hook thread.
        // Dropping an event only costs a missed correction, but a blocked callback
        // gets the hook silently torn down by Windows.
        let _ = tx.try_send(ev);
    }
}

/// Turn a raw hook struct into a buffer event, or `None` to ignore it entirely.
unsafe fn interpret(kb: &KBDLLHOOKSTRUCT) -> Option<KeyEvent> {
    if kb.flags.0 & LLKHF_INJECTED.0 != 0 {
        return if kb.dwExtraInfo == R3W_INJECT_TAG {
            // Ours. Drop unconditionally — this is what stops a correction from
            // re-entering the buffer and looping, and what keeps R3write's own
            // quick-edit Ctrl+C / Ctrl+V from looking like typing.
            None
        } else {
            // Injected by something else: another automation tool, an on-screen
            // keyboard, a virtual HID, a remote-control session. We did not type it
            // and cannot model what it did to the document.
            Some(KeyEvent::Invalidate(Reason::ForeignInjectedInput))
        };
    }

    let mods = Modifiers {
        ctrl: is_down(VK_CONTROL.0),
        alt: is_down(VK_MENU.0),
        win: is_down(VK_LWIN.0) || is_down(VK_RWIN.0),
    };

    Some(classify(kb.vkCode, mods, mapped_char(kb, mods)))
}

/// Physical key state. `GetAsyncKeyState`, never `GetKeyState` — see the module
/// docs for why the latter is always empty on this thread.
unsafe fn is_down(vk: u16) -> bool {
    GetAsyncKeyState(vk as i32) as u16 & 0x8000 != 0
}

/// The character this key actually produces, honouring Shift, CapsLock, AltGr and
/// the active keyboard layout.
///
/// Uses `ToUnicodeEx` with `wFlags` bit 2 (`0x4`), which translates *without*
/// disturbing the keyboard's dead-key state — the reason `MapVirtualKeyW` was used
/// here originally. `MapVirtualKeyW(MAPVK_VK_TO_CHAR)` only ever returns the
/// unshifted character, so `?` came back as `/` and `:` as `;`, and the correction
/// then injected that wrong delimiter back into the user's text.
unsafe fn mapped_char(kb: &KBDLLHOOKSTRUCT, mods: Modifiers) -> Option<char> {
    // Ctrl/Alt combinations are shortcuts; `classify` discards them before looking
    // at the character, and asking ToUnicodeEx would just yield control codes.
    if mods.any_shortcut() {
        return None;
    }

    // Build the key-state array by hand from physical state. `GetKeyboardState`
    // would have the same stale-thread problem as `GetKeyState`.
    let mut state = [0u8; 256];
    if is_down(VK_SHIFT.0) {
        state[VK_SHIFT.0 as usize] = 0x80;
    }
    // CapsLock is a toggle: the low bit, not the high one.
    if GetAsyncKeyState(VK_CAPITAL.0 as i32) as u16 & 0x0001 != 0 {
        state[VK_CAPITAL.0 as usize] = 0x01;
    }

    let layout = HKL(LAYOUT.load(Ordering::Relaxed) as *mut _);
    let mut buf = [0u16; 8];
    let n = ToUnicodeEx(
        kb.vkCode,
        kb.scanCode,
        &state,
        &mut buf,
        // 0x4 = do not modify keyboard state. Without it, translating a dead key
        // inside a hook consumes it, and the accent the user was composing never
        // reaches their document.
        0x4,
        Some(layout),
    );

    // n < 0 is a dead key, n == 0 is no translation. Neither is a character we can
    // reason about, so the buffer invalidates rather than guessing.
    if n != 1 {
        return None;
    }
    char::from_u32(buf[0] as u32)
}
