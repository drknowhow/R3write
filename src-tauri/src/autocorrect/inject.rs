//! The single chokepoint for every synthetic keystroke R3write sends.
//!
//! Nothing in this app may call `SendInput` (or enigo) directly. Everything goes
//! through here so that each event carries [`R3W_INJECT_TAG`] in `dwExtraInfo` and
//! the keyboard hook can recognise our own output.
//!
//! This is not a style preference. enigo provides no way to set `dwExtraInfo`, so
//! keystrokes it sends are indistinguishable from a foreign automation tool's. With
//! the hook live, R3write's own quick-edit `Ctrl+C` / `Ctrl+V` would come straight
//! back through the hook as if the user had typed them.

use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
    VIRTUAL_KEY, VK_BACK, VK_RETURN,
};

/// Stamped into `dwExtraInfo` on every event we synthesize. "R3WI".
///
/// The hook drops tagged events unconditionally. An event that is flagged injected
/// but does *not* carry this tag belongs to someone else, and invalidates the
/// buffer rather than being ignored — we cannot model its effect on the document.
pub const R3W_INJECT_TAG: usize = 0x5233_5749;

/// Replace the last `backspaces` grapheme clusters with `text`.
///
/// Sent as ONE `SendInput` batch so Windows cannot interleave real user keystrokes
/// into the middle of a correction.
pub fn replace(backspaces: usize, text: &str) -> Result<(), String> {
    let mut inputs: Vec<INPUT> = Vec::with_capacity(backspaces * 2 + text.len() * 2);
    for _ in 0..backspaces {
        inputs.push(vk_event(VK_BACK, false));
        inputs.push(vk_event(VK_BACK, true));
    }
    for ch in text.chars() {
        // Enter must be sent as a virtual key, not as a Unicode packet. A
        // KEYEVENTF_UNICODE `\n` is delivered as a literal control character that
        // most editors ignore outright — so the newline the user typed would be
        // erased with the word and never restored, silently joining two lines.
        if ch == '\n' || ch == '\r' {
            inputs.push(vk_event(VK_RETURN, false));
            inputs.push(vk_event(VK_RETURN, true));
            continue;
        }
        let mut buf = [0u16; 2];
        for unit in ch.encode_utf16(&mut buf) {
            inputs.push(unicode_event(*unit, false));
            inputs.push(unicode_event(*unit, true));
        }
    }
    send(&inputs)
}

/// Press `modifier`, click `key`, release `modifier` — e.g. Ctrl+C.
///
/// Replaces the old free-standing `send_modifier_combo` in `main.rs`, which used
/// enigo and therefore emitted untagged input.
pub fn modifier_combo(modifier: VIRTUAL_KEY, key: VIRTUAL_KEY) -> Result<(), String> {
    send(&[
        vk_event(modifier, false),
        vk_event(key, false),
        vk_event(key, true),
        vk_event(modifier, true),
    ])
}

/// Release modifiers the user may still be physically holding from a hotkey.
///
/// The old `capture_selection` did this with enigo before sending Ctrl+C; if the
/// held Alt survives, the copy is a no-op.
pub fn release_modifiers() -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };
    let events: Vec<INPUT> = [VK_MENU, VK_CONTROL, VK_SHIFT, VK_LWIN, VK_RWIN]
        .into_iter()
        .map(|vk| vk_event(vk, true))
        .collect();
    send(&events)
}

fn send(inputs: &[INPUT]) -> Result<(), String> {
    if inputs.is_empty() {
        return Ok(());
    }
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        return Err(format!("SendInput delivered {sent}/{}", inputs.len()));
    }
    Ok(())
}

fn vk_event(vk: VIRTUAL_KEY, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    Default::default()
                },
                time: 0,
                dwExtraInfo: R3W_INJECT_TAG,
            },
        },
    }
}

fn unicode_event(unit: u16, up: bool) -> INPUT {
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
