//! System-wide autocorrect.
//!
//! All state lives here in Rust rather than in the webviews. R3write runs two
//! webviews off one bundle with independent React state — settings changed in the
//! main window do not reach the quick-edit popup until it is recreated — so a
//! typing buffer split across them would desync immediately. The webviews are
//! views; this module is the owner.
//!
//! Threading:
//! - the **hook thread** ([`hook`]) does nothing but classify and forward;
//! - the **worker thread** (below) owns the buffer, dictionary, log and undo state;
//! - Tauri commands mutate config under a lock and signal the worker.

pub mod bubble;
pub mod buffer;
pub mod dict;
pub mod hook;
pub mod inject;
pub mod target;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use buffer::{backspaces_for, KeyEvent, Reason, ShadowBuffer};
use dict::Dict;
use target::Target;

/// Bound on the hook→worker queue. Large enough to absorb a fast typist's burst,
/// small enough that a wedged worker drops events instead of growing without limit.
const QUEUE_DEPTH: usize = 256;

const LOG_FILE: &str = "autocorrect-log.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutocorrectConfig {
    /// Master switch. Off by default — no hook exists until the user opts in.
    pub enabled: bool,
    /// Words shorter than this are never corrected; short words have the densest
    /// single-edit neighbourhoods and the least reliable guesses.
    pub min_word_length: usize,
    pub show_bubble: bool,
    /// Newline-separated process names. Empty means "correct nowhere".
    pub allowlist: String,
    /// Protected terms, reusing the existing Settings → Glossary field.
    pub protected_terms: String,
    pub log_retention: usize,
}

impl Default for AutocorrectConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            // 3, not 4: "teh" is the single most common typo in English and is
            // three letters. The dominance rule in `dict` is what keeps short
            // words safe, not an arbitrary length floor.
            min_word_length: 3,
            show_bubble: true,
            // Notepad only. Fail-closed: everything else is opt-in by hand until
            // it has been shown to survive backspace-and-retype.
            //
            // Browsers and Electron apps are now *safe* to add — the UIA probe in
            // `target` detects their password fields, and an unanswerable probe
            // refuses rather than guesses. They stay out of the default because
            // replacement itself is unproven there: autocomplete dropdowns can eat
            // keystrokes or replace a wider range than the typed word. That is a
            // correctness question for the Phase 0 matrix, not a safety one.
            allowlist: "notepad.exe".into(),
            protected_terms: String::new(),
            log_retention: 200,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorrectionEntry {
    pub id: String,
    pub timestamp: u64,
    pub original: String,
    pub correction: String,
    pub app: String,
    /// `"dict"` today. `"llm"` arrives with Phase 5 and never auto-injects.
    pub source: String,
    pub reverted: bool,
}

/// A correction that can still be reverted in place.
///
/// Only valid while the shadow buffer is still coherent — once the user navigates,
/// clicks, or commits another word, the caret is no longer where we think it is and
/// a "revert" would eat unrelated text. Retired rather than attempted.
struct PendingUndo {
    entry_id: String,
    original: String,
    correction: String,
    delimiter: char,
    /// Characters typed after the correction landed, in order.
    ///
    /// The undo has to erase these too — they sit between the caret and the
    /// correction — and then put them back, or pressing it would silently destroy
    /// whatever the user typed in the meantime.
    typed_since: String,
}

#[derive(Default)]
pub struct AutocorrectState {
    config: Arc<RwLock<AutocorrectConfig>>,
    log: Arc<Mutex<Vec<CorrectionEntry>>>,
    undo: Arc<Mutex<Option<PendingUndo>>>,
    /// Set once the license is confirmed active. The hook is refused until then —
    /// gating the UI alone would leave the keylogger running behind the paywall.
    license_active: Arc<AtomicBool>,
    worker_started: AtomicBool,
    /// Monotonic stamp on every emitted event so the two webviews can discard
    /// out-of-order renders instead of racing.
    version: AtomicU64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn new_id() -> String {
    // Monotonic-ish and collision-free enough for a local log; avoids pulling in a
    // uuid dependency for this alone.
    static N: AtomicU64 = AtomicU64::new(0);
    format!("{}-{}", now_ms(), N.fetch_add(1, Ordering::Relaxed))
}

impl AutocorrectState {
    fn snapshot(&self) -> AutocorrectConfig {
        self.config.read().map(|c| c.clone()).unwrap_or_default()
    }
}

/// Start the worker (idempotent) and bring the hook in line with the config.
fn apply(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AutocorrectState>();
    let cfg = state.snapshot();

    let want_hook = cfg.enabled && state.license_active.load(Ordering::SeqCst);

    // The undo shortcut is a system-wide resource; hold it only while the feature
    // that gives it meaning is actually running.
    crate::set_undo_shortcut_registered(app, want_hook);

    if want_hook {
        ensure_worker(app);
        hook::install()?;
    } else {
        hook::uninstall();
        // Anything half-typed under the old config is not ours to act on.
        retire_undo(app);
        bubble::hide(app);
    }
    Ok(())
}

/// Spawn the worker once. It outlives enable/disable cycles — disabling removes the
/// hook, so no events flow and the worker simply blocks on `recv`.
fn ensure_worker(app: &AppHandle) {
    let state = app.state::<AutocorrectState>();
    if state.worker_started.swap(true, Ordering::SeqCst) {
        return;
    }

    let (tx, rx) = sync_channel::<KeyEvent>(QUEUE_DEPTH);
    hook::set_sender(tx);

    let app = app.clone();
    std::thread::Builder::new()
        .name("r3write-autocorrect".into())
        .spawn(move || {
            let state = app.state::<AutocorrectState>();
            let own_pid = std::process::id();

            let mut buf = ShadowBuffer::default();
            let mut dictionary: Option<Dict> = None;
            let mut loaded_for_terms = String::new();
            let mut current_target = Target::default();
            let mut last_focus_check = 0u64;
            let mut current_layout = target::current_layout();

            // COM lives and dies on this thread — the probe is not Send, and is
            // deliberately never reachable from the hook thread.
            let uia = target::UiaProbe::new();
            if uia.is_none() {
                eprintln!(
                    "[r3write] running without UI Automation — apps that draw their own \
                     text fields (browsers, Electron) will be refused"
                );
            }

            // Focus can move *within* a process — tabbing from a username box to a
            // password box changes neither the process nor the HWND — so the
            // verdict is re-derived on the events that move focus rather than on a
            // timer, and it starts stale so nothing is corrected before the first
            // probe.
            //
            // CRITICAL ORDERING: the flag is set by the event that *causes* the
            // focus move, and consumed at the top of a LATER iteration. A low-level
            // hook sees a key before the target application processes it, so
            // probing while handling the Tab or mouse-down itself re-reads the
            // field being left and then marks the verdict fresh — which is exactly
            // how you end up buffering a password into a field marked "safe".
            // Deferring the probe by one event gives the app time to actually move
            // focus. Never set this flag after the probe block below.
            let mut target_stale = true;

            // One place to drop the buffer, so every reason is logged the same way
            // and no invalidation path can silently forget to clear the undo.
            macro_rules! drop_buffer {
                ($buf:expr, $reason:expr) => {{
                    if !$buf.is_empty() {
                        eprintln!("[r3write] autocorrect buffer dropped: {:?}", $reason);
                    }
                    $buf.invalidate();
                    retire_undo(&app);
                }};
            }

            while let Ok(ev) = rx.recv() {
                // Snapshot the hook's event counter as of this event. Anything that
                // arrives while we are deciding will bump it, and the injection is
                // abandoned rather than aimed at a caret that has since moved.
                let seq_at_commit = hook::event_seq();
                let cfg = state.snapshot();
                if !cfg.enabled {
                    drop_buffer!(buf, Reason::Disabled);
                    continue;
                }

                let now = now_ms();

                // Build the dictionary here, NOT inside the commit path. It takes
                // ~1s for 82k entries, and doing that while holding a committed
                // word meant real keystrokes piled up in the channel unseen — the
                // backspaces then landed past what the user had typed since.
                if dictionary.is_none() || loaded_for_terms != cfg.protected_terms {
                    let terms: Vec<String> = cfg
                        .protected_terms
                        .split(['\n', ','])
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect();
                    dictionary = Some(Dict::load(&terms));
                    loaded_for_terms = cfg.protected_terms.clone();
                    // The load blocked; anything typed during it is unaccounted for.
                    drop_buffer!(buf, Reason::Disabled);
                }

                // Consume the staleness set by an EARLIER event (see the note where
                // `target_stale` is declared). The 1500ms backstop catches focus
                // moves we get no signal for at all — a script stealing focus, a
                // dialog appearing. It is a safety net, not the mechanism.
                if target_stale || now.saturating_sub(last_focus_check) > 1500 {
                    last_focus_check = now;
                    target_stale = false;
                    let allow = target::parse_allowlist(&cfg.allowlist);
                    let next = target::current(&allow, own_pid, uia.as_ref());
                    if next.process != current_target.process {
                        // Focus moved: the document we were modelling is gone.
                        drop_buffer!(buf, Reason::FocusChange);
                    }
                    current_target = next;

                    // Language switch or IME composition start: the character a
                    // scan code produces has changed under us.
                    let layout = target::current_layout();
                    if layout != current_layout {
                        current_layout = layout;
                        drop_buffer!(buf, Reason::LayoutOrImeChange);
                    }
                    hook::set_layout(current_layout);
                }

                match ev {
                    KeyEvent::Invalidate(reason) => {
                        drop_buffer!(buf, reason);
                        // A click moves the caret, and possibly into a different
                        // field of the same window. Re-probe on the NEXT event, by
                        // which time the app will have processed the click.
                        if reason == Reason::MouseActivity {
                            target_stale = true;
                        }
                    }
                    KeyEvent::Char(c) => {
                        // Refuse to even BUFFER keystrokes we are not cleared to
                        // correct. Holding a password in memory — capped and
                        // unpersisted though it is — is not something to do when
                        // simply not collecting it is free.
                        if current_target.allowed {
                            buf.push(c);
                            // Track what has been typed since the last correction so
                            // undo can put it back. Without this the undo backspaces
                            // straight through these characters and destroys them.
                            if let Ok(mut u) = state.undo.lock() {
                                if let Some(p) = u.as_mut() {
                                    p.typed_since.push(c);
                                }
                            }
                        }
                    }
                    KeyEvent::Commit(delim) => {
                        // Any committed word retires the previous undo, whether or
                        // not this one gets corrected.
                        //
                        // Without this, correcting `teh` → `the` and then typing
                        // `quick ` would leave the undo pointing at `the` while the
                        // caret sits four characters further on. Firing it would
                        // backspace through `ick ` and paste `teh ` on top —
                        // corrupting text the user never asked us to touch.
                        retire_undo(&app);

                        let committed = buf.commit(delim);

                        // Tab always moves focus. Whatever we inject would land in
                        // whichever field the app has moved to, so a word ended with
                        // Tab is flushed and never corrected. Re-probe next event.
                        if delim == '\t' {
                            target_stale = true;
                            continue;
                        }

                        let Some(word) = committed else {
                            continue;
                        };
                        if !current_target.allowed {
                            continue;
                        }

                        let Some(fix) = dictionary
                            .as_ref()
                            .and_then(|d| d.suggest(&word, cfg.min_word_length))
                        else {
                            continue;
                        };

                        // Did anything arrive while we were deciding? `buf.is_empty()`
                        // cannot answer that — it only reflects what has been
                        // DRAINED from the channel, and the worker is single
                        // threaded, so it is empty by construction here. The hook's
                        // sequence counter is the real check.
                        if hook::event_seq() != seq_at_commit {
                            continue;
                        }

                        // Last line of defence before we type: re-resolve the target
                        // now, not from a cached verdict. Enter can submit a form and
                        // move focus, a dialog can steal it, and the backstop may be
                        // up to 1500ms out of date. If anything has changed, drop the
                        // correction rather than inject somewhere unverified.
                        let allow = target::parse_allowlist(&cfg.allowlist);
                        let fresh = target::current(&allow, own_pid, uia.as_ref());
                        if !fresh.allowed || fresh.process != current_target.process {
                            eprintln!(
                                "[r3write] correction aborted: target changed between commit and inject"
                            );
                            target_stale = true;
                            continue;
                        }

                        let erase = backspaces_for(&word) + 1; // + the delimiter
                        let replacement = format!("{fix}{delim}");
                        if let Err(e) = inject::replace(erase, &replacement) {
                            eprintln!("[r3write] autocorrect injection failed: {e}");
                            continue;
                        }

                        let entry = CorrectionEntry {
                            id: new_id(),
                            timestamp: now_ms(),
                            original: word.clone(),
                            correction: fix.clone(),
                            app: current_target.process.clone(),
                            source: "dict".into(),
                            reverted: false,
                        };

                        if let Ok(mut u) = state.undo.lock() {
                            *u = Some(PendingUndo {
                                entry_id: entry.id.clone(),
                                original: word,
                                correction: fix,
                                delimiter: delim,
                                typed_since: String::new(),
                            });
                        }

                        push_log(&app, entry, cfg.log_retention, cfg.show_bubble);
                    }
                }
            }
        })
        .ok();
}

/// How many characters to erase, and what to type back, to revert a correction.
///
/// Pure so the arithmetic is testable — this calculation has been the source of
/// every text-corruption bug in this feature so far.
///
/// The correction, its delimiter, and everything typed since all have to come out:
/// the characters typed since sit between the caret and the text being reverted, so
/// there is no way to reach it without erasing them. They are then typed back
/// verbatim. Erasing only the correction would delete the user's newer keystrokes
/// and leave the correction in place.
fn undo_plan(
    correction: &str,
    delimiter: char,
    original: &str,
    typed_since: &str,
) -> (usize, String) {
    let erase = backspaces_for(correction) + 1 + backspaces_for(typed_since);
    (erase, format!("{original}{delimiter}{typed_since}"))
}

/// Drop the pending undo and take the toast down with it.
///
/// The two are deliberately tied: an Undo button that is still on screen after the
/// undo has stopped being safe is worse than no button at all. When the affordance
/// disappears, it is because pressing it would now hit the wrong text.
fn retire_undo(app: &AppHandle) {
    let state = app.state::<AutocorrectState>();
    let had = state
        .undo
        .lock()
        .map(|mut u| u.take().is_some())
        .unwrap_or(false);
    if had {
        let a = app.clone();
        let _ = app.run_on_main_thread(move || bubble::hide(&a));
    }
}

fn push_log(app: &AppHandle, entry: CorrectionEntry, retention: usize, show_bubble: bool) {
    let state = app.state::<AutocorrectState>();
    if let Ok(mut log) = state.log.lock() {
        log.push(entry.clone());
        let len = log.len();
        if len > retention {
            log.drain(0..len - retention);
        }
        persist(app, &log);
    }
    let version = state.version.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = app.emit(
        "autocorrect:applied",
        serde_json::json!({ "version": version, "entry": entry, "showBubble": show_bubble }),
    );

    // Show after emitting so the toast has its content before it becomes visible
    // and never flashes an empty frame. Must run on the GUI thread — the worker
    // does not own the window handle, and Windows' foreground rules are far more
    // forgiving when the owning thread makes the call.
    if show_bubble {
        let a = app.clone();
        let _ = app.run_on_main_thread(move || bubble::show(&a));
    }
}

fn log_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(LOG_FILE))
}

fn persist(app: &AppHandle, log: &[CorrectionEntry]) {
    if let Some(p) = log_path(app) {
        if let Ok(json) = serde_json::to_string(log) {
            let _ = std::fs::write(p, json);
        }
    }
}

fn restore(app: &AppHandle) -> Vec<CorrectionEntry> {
    log_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Whether the user ticked "Enable system-wide autocorrect" in the installer.
///
/// This is a *preference*, not a switch. It seeds the first-run default in
/// Settings; the hook still requires an active license and an explicit enabled
/// config. Absent key (sideloaded build, portable copy) reads as `false`.
#[tauri::command]
pub fn autocorrect_installer_opt_in() -> bool {
    #[cfg(windows)]
    {
        // Without CREATE_NO_WINDOW, spawning reg.exe flashes a console window on
        // a GUI app — visible at startup, and it looks like malware.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        // Must match the fixed key in installer/installer.nsi. Read via reg.exe
        // to avoid pulling in a registry crate for one lookup.
        let out = std::process::Command::new("reg")
            .args(["query", r"HKCU\Software\R3write", "/v", "AutocorrectOptIn"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        if let Ok(o) = out {
            let s = String::from_utf8_lossy(&o.stdout);
            return s.split_whitespace().any(|t| t == "0x1");
        }
    }
    false
}

/// Load the persisted log at startup. Does NOT install the hook — that waits for an
/// explicit enable from a licensed session.
pub fn init(app: &AppHandle) {
    // let-else rather than `if let`: an `if let` in tail position keeps its
    // temporary Result alive past the locals it borrows from, which does not
    // compile. Binding the guard as a local gets the drop order right.
    let restored = restore(app);
    let log_arc = app.state::<AutocorrectState>().log.clone();
    let Ok(mut log) = log_arc.lock() else { return };
    *log = restored;
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn autocorrect_set_config(
    app: AppHandle,
    config: AutocorrectConfig,
    state: tauri::State<AutocorrectState>,
) -> Result<(), String> {
    *state.config.write().map_err(|e| e.to_string())? = config;
    apply(&app)
}

#[tauri::command]
pub fn autocorrect_get_config(state: tauri::State<AutocorrectState>) -> AutocorrectConfig {
    state.snapshot()
}

/// Told by the frontend once Lemon Squeezy validation succeeds. Flipping this off
/// tears the hook down immediately.
#[tauri::command]
pub fn autocorrect_set_license_active(
    app: AppHandle,
    active: bool,
    state: tauri::State<AutocorrectState>,
) -> Result<(), String> {
    state.license_active.store(active, Ordering::SeqCst);
    apply(&app)
}

#[tauri::command]
pub fn autocorrect_status(state: tauri::State<AutocorrectState>) -> serde_json::Value {
    serde_json::json!({
        "hookInstalled": hook::is_installed(),
        "licenseActive": state.license_active.load(Ordering::SeqCst),
        "enabled": state.snapshot().enabled,
    })
}

/// Take the toast down without reverting — the auto-fade timer, or a dismiss click.
///
/// Leaves the pending undo intact: the correction is still the last thing typed, so
/// the undo hotkey keeps working after the toast has faded.
#[tauri::command]
pub fn autocorrect_dismiss_bubble(app: AppHandle) {
    bubble::hide(&app);
}

#[tauri::command]
pub fn autocorrect_get_log(state: tauri::State<AutocorrectState>) -> Vec<CorrectionEntry> {
    state.log.lock().map(|l| l.clone()).unwrap_or_default()
}

#[tauri::command]
pub fn autocorrect_clear_log(app: AppHandle, state: tauri::State<AutocorrectState>) {
    if let Ok(mut log) = state.log.lock() {
        log.clear();
        persist(&app, &log);
    }
}

/// Revert the most recent correction in place.
///
/// Only succeeds while the correction is still the last thing typed. Once the user
/// has moved on we retire the undo rather than guess — a stale revert would delete
/// whatever now sits under the caret.
#[tauri::command]
pub fn autocorrect_undo_last(
    app: AppHandle,
    state: tauri::State<AutocorrectState>,
) -> Result<bool, String> {
    let pending = match state.undo.lock().map_err(|e| e.to_string())?.take() {
        Some(p) => p,
        None => return Ok(false),
    };

    // Take the toast down and let Windows hand focus back BEFORE injecting.
    //
    // This matters most when undo is triggered by clicking the toast: at that
    // moment the toast holds focus, so injecting immediately would type the
    // backspaces into our own window instead of the user's document. The same
    // hide-then-settle dance `accept_rewrite` needs, for the same reason.
    bubble::hide(&app);
    std::thread::sleep(std::time::Duration::from_millis(90));

    let (erase, restored) = undo_plan(
        &pending.correction,
        pending.delimiter,
        &pending.original,
        &pending.typed_since,
    );
    inject::replace(erase, &restored)?;

    if let Ok(mut log) = state.log.lock() {
        if let Some(e) = log.iter_mut().find(|e| e.id == pending.entry_id) {
            e.reverted = true;
        }
        persist(&app, &log);
    }
    let version = state.version.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = app.emit(
        "autocorrect:reverted",
        serde_json::json!({ "version": version, "id": pending.entry_id }),
    );
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undo_with_nothing_typed_since_reverts_just_the_correction() {
        let (erase, restored) = undo_plan("the", ' ', "teh", "");
        assert_eq!(erase, 4, "3 for `the` + 1 for the space");
        assert_eq!(restored, "teh ");
    }

    #[test]
    fn undo_preserves_characters_typed_after_the_correction() {
        // The regression this function exists for. `teh ` was corrected to `the `,
        // then the user typed `qui`. Erasing only `the ` would have backspaced
        // through `qui` and produced `theteh `, destroying their input.
        let (erase, restored) = undo_plan("the", ' ', "teh", "qui");
        assert_eq!(erase, 7, "`the` + space + the three characters typed since");
        assert_eq!(restored, "teh qui", "the user's typing must come back verbatim");
    }

    #[test]
    fn undo_counts_graphemes_not_chars() {
        // A combining accent is two `char`s but one Backspace; an emoji is one
        // `char` in Rust but a surrogate pair in UTF-16. Either miscount eats a
        // neighbouring character.
        let (erase, _) = undo_plan("cafe\u{0301}", ' ', "cafe", "");
        assert_eq!(erase, 5, "4 visible glyphs + the delimiter");

        let (erase, restored) = undo_plan("the", ' ', "teh", "👍");
        assert_eq!(erase, 5);
        assert_eq!(restored, "teh 👍");
    }

    #[test]
    fn undo_round_trips_the_delimiter_that_was_actually_typed() {
        // The delimiter is stored rather than assumed: a word ended with `?` must
        // be restored with `?`, not a space.
        let (_, restored) = undo_plan("the", '?', "teh", "");
        assert_eq!(restored, "teh?");
    }
}
