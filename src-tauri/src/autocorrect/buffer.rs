//! The shadow buffer, and the rules for when to throw it away.
//!
//! # The core hazard
//!
//! The keyboard hook observes **key intent, not document text**. Between two
//! keystrokes the real document can change in ways no key event describes: the user
//! clicks to move the caret, accepts an autocomplete that replaces a wider range
//! than was typed, pastes, dictates, or the host app runs its own autocorrect
//! (Word does). Focus never changes, so nothing obvious signals the drift.
//!
//! A desynced buffer does not cause a missed correction — it causes us to replace
//! the **wrong substring**, which is corruption of the user's text. So invalidation
//! is deliberately aggressive: when in doubt, drop the buffer. A dropped buffer
//! costs one missed typo.
//!
//! [`classify`] is pure and Win32-free precisely so this logic is unit-testable.

use unicode_segmentation::UnicodeSegmentation;

/// Why the shadow buffer stopped being trustworthy. Kept as a type rather than a
/// string so the reasons are exhaustive and greppable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    CaretNavigation,
    MouseActivity,
    ModifierShortcut,
    ManualDelete,
    Escape,
    FocusChange,
    ForeignInjectedInput,
    LayoutOrImeChange,
    UnmappedKey,
    Disabled,
}

/// What a keystroke means to the buffer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyEvent {
    /// A character the user typed that extends the current word.
    Char(char),
    /// A delimiter that commits the current word.
    Commit(char),
    /// Something happened that desyncs us from the document.
    Invalidate(Reason),
}

/// Modifier state at the moment of a keypress.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Modifiers {
    pub ctrl: bool,
    pub alt: bool,
    pub win: bool,
}

impl Modifiers {
    /// Shift is deliberately excluded — it produces capitals, it is not a shortcut.
    pub fn any_shortcut(&self) -> bool {
        self.ctrl || self.alt || self.win
    }
}

// Virtual-key codes we care about, as plain u32 so this module stays Win32-free
// and testable on any host.
pub mod vk {
    // A reference table: some entries exist to document the codes that collide
    // with punctuation codepoints, even where nothing reads them yet.
    #![allow(dead_code)]

    pub const BACK: u32 = 0x08;
    pub const TAB: u32 = 0x09;
    pub const RETURN: u32 = 0x0D;
    pub const ESCAPE: u32 = 0x1B;
    pub const SPACE: u32 = 0x20;
    pub const PRIOR: u32 = 0x21;
    pub const NEXT: u32 = 0x22;
    pub const END: u32 = 0x23;
    pub const HOME: u32 = 0x24;
    pub const LEFT: u32 = 0x25;
    pub const UP: u32 = 0x26;
    pub const RIGHT: u32 = 0x27;
    pub const DOWN: u32 = 0x28;
    pub const DELETE: u32 = 0x2E;

    // OEM keys. These matter because a virtual-key code is NOT a character code:
    // `'.'` is 0x2E as a codepoint, which is VK_DELETE. Anything reasoning about
    // punctuation must use the OEM code and read the character from `mapped`.
    pub const OEM_1: u32 = 0xBA; // ;:
    pub const OEM_COMMA: u32 = 0xBC;
    pub const OEM_PERIOD: u32 = 0xBE;
    pub const OEM_7: u32 = 0xDE; // '"
}

/// Decide what a keystroke means. Pure: no Win32, no globals, no I/O.
///
/// `mapped` is the character the key would produce under the active layout, or
/// `None` if it does not map to one.
pub fn classify(vkey: u32, mods: Modifiers, mapped: Option<char>) -> KeyEvent {
    // Shortcuts are checked first: Ctrl+V, Ctrl+X and Ctrl+Z all mutate the
    // document invisibly to us, and Ctrl+<letter> would otherwise look like typing.
    if mods.any_shortcut() {
        return KeyEvent::Invalidate(Reason::ModifierShortcut);
    }

    match vkey {
        vk::LEFT | vk::RIGHT | vk::UP | vk::DOWN | vk::HOME | vk::END | vk::PRIOR | vk::NEXT => {
            KeyEvent::Invalidate(Reason::CaretNavigation)
        }
        vk::ESCAPE => KeyEvent::Invalidate(Reason::Escape),
        // The user fixing their own typo. Our count of what is on screen is now
        // behind by one and we have no way to catch up.
        vk::BACK | vk::DELETE => KeyEvent::Invalidate(Reason::ManualDelete),
        vk::SPACE => KeyEvent::Commit(' '),
        vk::RETURN => KeyEvent::Commit('\n'),
        vk::TAB => KeyEvent::Commit('\t'),
        _ => match mapped {
            Some(c) if c.is_alphanumeric() || c == '\'' => KeyEvent::Char(c),
            Some(c) if c.is_ascii_punctuation() || c.is_whitespace() => KeyEvent::Commit(c),
            _ => KeyEvent::Invalidate(Reason::UnmappedKey),
        },
    }
}

/// The in-flight word plus a little preceding context.
///
/// Capped hard: raw keystrokes are never persisted and never grow without bound.
/// `context` exists only to give the Phase 5 LLM path something to reason about;
/// the dictionary path does not use it.
pub struct ShadowBuffer {
    word: String,
    context: String,
    context_cap: usize,
    word_cap: usize,
    /// Set when we lost sync *mid-word*. Characters are ignored until the next
    /// delimiter, and that word is never corrected.
    ///
    /// Without this, an invalidation part-way through `hel|lo` followed by `p` and
    /// a space would offer `p` as a word to correct — while the document actually
    /// holds something we never saw. Skipping one word is the cheap, safe answer.
    poisoned: bool,
}

impl Default for ShadowBuffer {
    fn default() -> Self {
        Self::new(64, 200)
    }
}

impl ShadowBuffer {
    pub fn new(word_cap: usize, context_cap: usize) -> Self {
        Self {
            word: String::new(),
            context: String::new(),
            context_cap,
            word_cap,
            poisoned: false,
        }
    }

    pub fn push(&mut self, c: char) {
        if self.poisoned {
            return;
        }
        self.word.push(c);
        // A "word" this long is not a word — most likely we drifted out of sync and
        // are accumulating garbage. Poison rather than merely clear, so the tail of
        // the run cannot masquerade as a fresh short word.
        if self.word.chars().count() > self.word_cap {
            self.word.clear();
            self.poisoned = true;
        }
    }

    /// Take the finished word, moving it into the rolling context.
    ///
    /// A delimiter is a clean restart point, so it also clears poisoning — the
    /// *next* word is trustworthy again.
    pub fn commit(&mut self, delim: char) -> Option<String> {
        if self.poisoned {
            self.poisoned = false;
            self.word.clear();
            return None;
        }
        let word = std::mem::take(&mut self.word);
        self.context.push_str(&word);
        self.context.push(delim);
        while self.context.chars().count() > self.context_cap {
            // Drop from the front, staying on a char boundary.
            let mut it = self.context.chars();
            it.next();
            self.context = it.as_str().to_string();
        }
        if word.is_empty() {
            None
        } else {
            Some(word)
        }
    }

    /// Forget everything. Called on every [`Reason`].
    ///
    /// Poisons only if we were mid-word. Invalidating on an empty buffer (the
    /// common case — switching apps while not typing) costs nothing, so there is no
    /// reason to make the user forfeit their next word too.
    pub fn invalidate(&mut self) {
        if !self.word.is_empty() {
            self.poisoned = true;
        }
        self.word.clear();
        self.context.clear();
    }

    /// The word currently being typed. Used by tests and diagnostics.
    #[allow(dead_code)]
    pub fn word(&self) -> &str {
        &self.word
    }

    /// Recent committed text. Nothing reads this yet — it exists so Phase 5's
    /// LLM arbitration has the surrounding sentence without needing to widen the
    /// buffer later. Never persisted, and cleared by every invalidation.
    #[allow(dead_code)]
    pub fn context(&self) -> &str {
        &self.context
    }

    pub fn is_empty(&self) -> bool {
        self.word.is_empty()
    }
}

/// Number of Backspace presses needed to erase `s`.
///
/// Grapheme clusters, not `char`s and not bytes. `"é"` may be two `char`s (e +
/// combining accent) but one Backspace; `"👍"` is one `char` in Rust but a
/// surrogate pair in UTF-16. Getting this wrong eats a neighbouring character —
/// the Phase 0 spike used `.chars().count()` on purpose so the difference showed up.
pub fn backspaces_for(s: &str) -> usize {
    s.graphemes(true).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain() -> Modifiers {
        Modifiers::default()
    }

    // --- invalidation: one test per trigger, each asserting the buffer empties ---

    #[test]
    fn caret_navigation_invalidates() {
        for k in [vk::LEFT, vk::RIGHT, vk::UP, vk::DOWN, vk::HOME, vk::END, vk::PRIOR, vk::NEXT] {
            assert_eq!(
                classify(k, plain(), None),
                KeyEvent::Invalidate(Reason::CaretNavigation),
                "vk {k:#x} should invalidate"
            );
        }
    }

    #[test]
    fn paste_cut_undo_invalidate() {
        let ctrl = Modifiers { ctrl: true, ..Default::default() };
        for c in ['v', 'x', 'z'] {
            assert_eq!(
                classify(c as u32, ctrl, Some(c)),
                KeyEvent::Invalidate(Reason::ModifierShortcut),
                "Ctrl+{c} must invalidate — it mutates the document invisibly"
            );
        }
    }

    #[test]
    fn manual_delete_invalidates() {
        assert_eq!(classify(vk::BACK, plain(), None), KeyEvent::Invalidate(Reason::ManualDelete));
        assert_eq!(classify(vk::DELETE, plain(), None), KeyEvent::Invalidate(Reason::ManualDelete));
    }

    #[test]
    fn shift_is_not_a_shortcut() {
        // Shift produces capitals; treating it as a shortcut would invalidate on
        // every capital letter and disable the feature for ordinary sentences.
        assert_eq!(classify('A' as u32, plain(), Some('A')), KeyEvent::Char('A'));
    }

    #[test]
    fn delimiters_commit() {
        assert_eq!(classify(vk::SPACE, plain(), None), KeyEvent::Commit(' '));
        assert_eq!(classify(vk::RETURN, plain(), None), KeyEvent::Commit('\n'));
        assert_eq!(classify(vk::TAB, plain(), None), KeyEvent::Commit('\t'));
        // OEM code, not the codepoint — see the note in `vk`.
        assert_eq!(classify(vk::OEM_PERIOD, plain(), Some('.')), KeyEvent::Commit('.'));
        assert_eq!(classify(vk::OEM_COMMA, plain(), Some(',')), KeyEvent::Commit(','));
    }

    #[test]
    fn letters_and_apostrophes_extend_the_word() {
        assert_eq!(classify('A' as u32, plain(), Some('a')), KeyEvent::Char('a'));
        assert_eq!(classify(vk::OEM_7, plain(), Some('\'')), KeyEvent::Char('\''));
    }

    #[test]
    fn punctuation_vkeys_are_not_confused_with_control_keys() {
        // `'.'` is codepoint 0x2E, which is also VK_DELETE, and `'\''` is 0x27,
        // which is VK_RIGHT. Reading punctuation off the vkey instead of `mapped`
        // would silently turn every full stop into a buffer invalidation.
        assert_eq!(
            classify(vk::DELETE, plain(), None),
            KeyEvent::Invalidate(Reason::ManualDelete)
        );
        assert_eq!(
            classify(vk::OEM_PERIOD, plain(), Some('.')),
            KeyEvent::Commit('.')
        );
    }

    // --- buffer behaviour ---

    #[test]
    fn commit_returns_the_word_and_clears_it() {
        let mut b = ShadowBuffer::default();
        for c in "teh".chars() {
            b.push(c);
        }
        assert_eq!(b.commit(' ').as_deref(), Some("teh"));
        assert!(b.is_empty());
        assert_eq!(b.context(), "teh ");
    }

    #[test]
    fn commit_on_empty_word_yields_nothing() {
        let mut b = ShadowBuffer::default();
        assert_eq!(b.commit(' '), None);
    }

    #[test]
    fn invalidate_empties_word_and_context() {
        let mut b = ShadowBuffer::default();
        for c in "hello".chars() {
            b.push(c);
        }
        b.commit(' ');
        for c in "wor".chars() {
            b.push(c);
        }
        b.invalidate();
        assert!(b.is_empty());
        assert_eq!(b.context(), "");
    }

    #[test]
    fn overlong_word_poisons_rather_than_restarting() {
        let mut b = ShadowBuffer::new(8, 200);
        for c in "abcdefghijklmno".chars() {
            b.push(c);
        }
        assert!(b.is_empty(), "a 15-char run past an 8-char cap means we drifted");
        // The tail of the run must NOT become a fresh, correctable short word.
        assert_eq!(b.commit(' '), None, "poisoned word must not be offered");
    }

    #[test]
    fn mid_word_invalidation_skips_exactly_one_word() {
        let mut b = ShadowBuffer::default();
        for c in "hel".chars() {
            b.push(c);
        }
        b.invalidate(); // e.g. the user clicked elsewhere
        for c in "p".chars() {
            b.push(c);
        }
        assert_eq!(b.commit(' '), None, "the interrupted word is not trustworthy");

        // ...but the next one is.
        for c in "teh".chars() {
            b.push(c);
        }
        assert_eq!(b.commit(' ').as_deref(), Some("teh"));
    }

    #[test]
    fn invalidation_on_empty_buffer_does_not_cost_the_next_word() {
        // Switching apps while not mid-word is the common case; forfeiting the
        // user's next word for it would be pure annoyance.
        let mut b = ShadowBuffer::default();
        b.invalidate();
        for c in "teh".chars() {
            b.push(c);
        }
        assert_eq!(b.commit(' ').as_deref(), Some("teh"));
    }

    #[test]
    fn context_is_capped() {
        let mut b = ShadowBuffer::new(64, 10);
        for _ in 0..10 {
            for c in "word".chars() {
                b.push(c);
            }
            b.commit(' ');
        }
        assert!(b.context().chars().count() <= 10);
    }

    // --- grapheme counting: the case the spike was built to expose ---

    #[test]
    fn backspace_count_is_graphemes_not_chars() {
        assert_eq!(backspaces_for("teh"), 3);
        // Combining acute: 2 chars, 1 grapheme, 1 backspace.
        assert_eq!(backspaces_for("e\u{0301}"), 1);
        // Emoji: 1 char in Rust, still 1 backspace.
        assert_eq!(backspaces_for("👍"), 1);
        // Family emoji via ZWJ: many chars, one grapheme.
        assert_eq!(backspaces_for("👨‍👩‍👧"), 1);
    }
}
