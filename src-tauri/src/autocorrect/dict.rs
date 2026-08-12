//! Offline typo detection. No network, no cost, no keystrokes leaving the machine.
//!
//! This is the only thing allowed to trigger an automatic correction. The LLM path
//! (Phase 5) may *suggest*, never auto-inject — see the plan for why.

use std::collections::HashSet;

use symspell::{SymSpell, UnicodeStringStrategy, Verbosity};

/// Word/frequency list from the SymSpell project (MIT), derived from Google Books
/// Ngram data. ~82.8k entries, compiled into the binary.
///
/// NOTE: this file starts with a UTF-8 BOM. Left unstripped it would bind the
/// most common word in English to "\u{feff}the" and silently never match it.
const RAW_DICTIONARY: &str = include_str!("../../resources/frequency_dictionary_en_82_765.txt");

/// Maximum edit distance we will ever consider. `lookup` panics if asked for more
/// than the value the index was built with, so the two are tied together here.
const MAX_EDIT_DISTANCE: i64 = 2;

/// How much more common the best candidate must be than the runner-up before we
/// will correct without asking.
///
/// "Exactly one candidate" was the original rule and it was wrong: `teh` has
/// several neighbours at distance 1 (`the`, `ten`, `tea`), so the canonical typo in
/// English would never have been corrected. What actually distinguishes it is that
/// `the` is ~200x more frequent than the alternatives. Where no candidate dominates
/// — `cta` → `cat`/`act` — we stay out of the way.
const DOMINANCE: i64 = 10;

pub struct Dict {
    sym: SymSpell<UnicodeStringStrategy>,
    /// Lowercased protected terms — brand names, jargon, anything the user told us
    /// to leave alone via the existing Settings → Glossary field.
    protected: HashSet<String>,
}

impl Dict {
    /// Parse the bundled dictionary. Costs roughly a second and ~30MB, so it is
    /// built lazily on first enable rather than at app start.
    pub fn load(protected_terms: &[String]) -> Self {
        let mut sym: SymSpell<UnicodeStringStrategy> = SymSpell::default();
        let mut loaded = 0usize;
        for (i, line) in RAW_DICTIONARY.lines().enumerate() {
            let line = if i == 0 {
                line.trim_start_matches('\u{feff}')
            } else {
                line
            };
            if line.trim().is_empty() {
                continue;
            }
            if sym.load_dictionary_line(line, 0, 1, " ") {
                loaded += 1;
            }
        }
        eprintln!("[r3write] autocorrect dictionary loaded: {loaded} entries");

        Self {
            sym,
            protected: protected_terms
                .iter()
                .map(|t| t.trim().to_lowercase())
                .filter(|t| !t.is_empty())
                .collect(),
        }
    }

    /// Return a correction for `word`, or `None` to leave it alone.
    ///
    /// Deliberately conservative. We only auto-correct when there is exactly one
    /// plausible answer; anything ambiguous is left for the user (or, once Phase 5
    /// lands, offered as a suggestion).
    pub fn suggest(&self, word: &str, min_len: usize) -> Option<String> {
        if word.chars().count() < min_len {
            return None;
        }
        // Anything with a digit or symbol is an identifier, version number, or
        // token — not prose, and not ours to touch.
        if !word.chars().all(|c| c.is_alphabetic() || c == '\'') {
            return None;
        }

        let lower = word.to_lowercase();
        if self.protected.contains(&lower) {
            return None;
        }

        let mut hits = self.sym.lookup(&lower, Verbosity::Closest, MAX_EDIT_DISTANCE);

        // Distance 0 means the word is in the dictionary — it is spelled fine.
        // Real-word errors ("form" for "from") are invisible here by design; that
        // is exactly the case Phase 5's LLM arbitration exists for.
        if hits.first()?.distance == 0 {
            return None;
        }

        // Nearest first, then most frequent. Do not rely on the crate's ordering.
        hits.sort_by(|a, b| a.distance.cmp(&b.distance).then(b.count.cmp(&a.count)));

        let first = hits.first()?;
        if let Some(second) = hits.get(1) {
            // Only overrule the user when one answer is overwhelmingly likely.
            if first.count < second.count.saturating_mul(DOMINANCE) {
                return None;
            }
        }

        Some(match_case(word, &first.term))
    }
}

/// Carry the user's capitalisation onto the correction.
///
/// Without this, "Teh quick" becomes "the quick" and the user has to fix the
/// sentence start we just broke.
fn match_case(original: &str, corrected: &str) -> String {
    let mut chars = original.chars();
    let first_upper = chars.next().is_some_and(|c| c.is_uppercase());
    let rest_upper = original.chars().skip(1).any(|c| c.is_uppercase());
    let all_upper = original.chars().filter(|c| c.is_alphabetic()).count() > 1
        && original.chars().filter(|c| c.is_alphabetic()).all(|c| c.is_uppercase());

    if all_upper {
        corrected.to_uppercase()
    } else if first_upper && !rest_upper {
        let mut it = corrected.chars();
        match it.next() {
            Some(f) => f.to_uppercase().collect::<String>() + it.as_str(),
            None => corrected.to_string(),
        }
    } else {
        corrected.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    // Loading is ~1s, so share one instance across the suite.
    fn dict() -> &'static Dict {
        static D: OnceLock<Dict> = OnceLock::new();
        D.get_or_init(|| Dict::load(&["Tauri".into(), "R3write".into()]))
    }

    #[test]
    fn bom_does_not_corrupt_the_first_entry() {
        // "the" is line 1 of the dictionary and sits behind a UTF-8 BOM. If the BOM
        // leaks in, "the" is unknown and gets "corrected" into something else.
        assert_eq!(dict().suggest("the", 3), None, "`the` must be a known word");
    }

    #[test]
    fn corrects_common_typos() {
        for (typo, want) in [("teh", "the"), ("recieve", "receive"), ("seperate", "separate")] {
            assert_eq!(
                dict().suggest(typo, 3).as_deref(),
                Some(want),
                "{typo} should correct to {want}"
            );
        }
    }

    #[test]
    fn ambiguous_typos_are_left_alone() {
        // No dominant candidate means no correction. Guessing here is precisely how
        // autocorrect earns its reputation.
        assert_eq!(dict().suggest("cta", 3), None);
    }

    #[test]
    fn leaves_correctly_spelled_words_alone() {
        for w in ["quick", "brown", "keyboard", "correction"] {
            assert_eq!(dict().suggest(w, 4), None, "{w} is spelled correctly");
        }
    }

    #[test]
    fn respects_min_length() {
        assert_eq!(dict().suggest("teh", 4), None, "below min_len must be skipped");
        assert!(dict().suggest("teh", 3).is_some(), "at min_len it must fire");
    }

    #[test]
    fn protected_terms_are_never_corrected() {
        assert_eq!(dict().suggest("Tauri", 4), None);
        assert_eq!(dict().suggest("tauri", 4), None);
    }

    #[test]
    fn skips_identifiers_and_versions() {
        for w in ["v1", "utf8", "sha256", "x64"] {
            assert_eq!(dict().suggest(w, 3), None, "{w} is not prose");
        }
    }

    #[test]
    fn preserves_capitalisation() {
        assert_eq!(match_case("Teh", "the"), "The");
        assert_eq!(match_case("TEH", "the"), "THE");
        assert_eq!(match_case("teh", "the"), "the");
    }

    #[test]
    fn sentence_initial_typo_keeps_its_capital() {
        assert_eq!(dict().suggest("Teh", 3).as_deref(), Some("The"));
    }

    #[test]
    fn dominance_threshold_is_what_makes_teh_work() {
        // Guard the reasoning, not just the outcome: `teh` has several distance-1
        // neighbours, so an "exactly one candidate" rule would reject it.
        let d = dict();
        assert!(d.suggest("teh", 3).is_some());
        assert_eq!(d.suggest("the", 3), None);
    }
}
