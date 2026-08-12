//! Offline typo detection. No network, no cost, no keystrokes leaving the machine.
//!
//! This is the only thing allowed to trigger an automatic correction. The LLM path
//! (Phase 5) may *suggest*, never auto-inject — see the plan for why.

use std::collections::HashSet;

use symspell::{SymSpell, Suggestion, UnicodeStringStrategy, Verbosity};

use super::shape::classify_edit;

/// Word/frequency list from the SymSpell project (MIT), derived from Google Books
/// Ngram data. ~82.8k entries, compiled into the binary.
///
/// NOTE: this file starts with a UTF-8 BOM. Left unstripped it would bind the
/// most common word in English to "\u{feff}the" and silently never match it.
const RAW_DICTIONARY: &str = include_str!("../../resources/frequency_dictionary_en_82_765.txt");

/// Maximum edit distance we will ever consider. `lookup` panics if asked for more
/// than the value the index was built with, so the two are tied together here.
const MAX_EDIT_DISTANCE: i64 = 2;

/// How far ahead the best candidate must be, on a frequency score weighted by the
/// shape of the typo, before we correct without asking.
///
/// This has been wrong twice. "Exactly one candidate" rejected `teh` → `the`.
/// Replacing it with a 10x raw-frequency lead then landed in the middle of the
/// real distribution — `adn` → `and` missed by 1.4x and `cta` → `cat` by 0.2x,
/// while `usee` was a 1.06x coin flip between `use` and `see`.
///
/// Both failures came from ranking on frequency alone. With `shape` weighting
/// carrying most of the discrimination, this only has to separate a clear winner
/// from a genuine tie, so it is far lower — and it is now checked against a corpus
/// of real typos in the tests below rather than picked by argument.
const DOMINANCE: i64 = 3;

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

        let hits = self.sym.lookup(&lower, Verbosity::Closest, MAX_EDIT_DISTANCE);

        // Distance 0 means the word is in the dictionary — it is spelled fine.
        // Real-word errors ("form" for "from") are invisible here by design; that
        // is exactly the case Phase 5's LLM arbitration exists for.
        if hits.first()?.distance == 0 {
            return None;
        }

        // Score by corpus frequency weighted by how plausible the typo is. Ranking
        // on frequency alone cannot separate `use` from `see` for input `usee`;
        // one is a doubled keystroke and the other swaps two distant keys.
        let mut scored: Vec<(i64, &Suggestion)> = hits
            .iter()
            .map(|h| {
                let w = classify_edit(&lower, &h.term).weight() as i64;
                (h.count.saturating_mul(w), h)
            })
            .collect();
        scored.sort_by(|a, b| b.0.cmp(&a.0));

        let (top_score, first) = *scored.first()?;
        if let Some((runner_up, _)) = scored.get(1) {
            // Only overrule the user when one answer is clearly ahead.
            if top_score < runner_up.saturating_mul(DOMINANCE) {
                return None;
            }
        }

        // `companys` → `company` is a real word, and wrong: it silently makes a
        // plural singular, which is worse than leaving the typo because the reader
        // may never notice. Getting `companies` needs morphology this engine does
        // not have, so these are left alone.
        if looks_like_intended_plural(&lower, &first.term) {
            return None;
        }

        Some(match_case(word, &first.term))
    }
}

/// Whether the typed word looks like a plural the user meant, whose correction
/// would silently make it singular.
///
/// `companys` sits one edit from `company` and two from `companies`, so edit
/// distance will always prefer the singular. Accepting that changes the meaning of
/// the sentence — a quieter failure than leaving the misspelling, because a real
/// word does not look wrong on re-reading. Consistent with the fail-closed stance
/// elsewhere: when we cannot get it right, do nothing.
fn looks_like_intended_plural(typed: &str, correction: &str) -> bool {
    let Some(stem) = typed.strip_suffix('s') else {
        return false;
    };

    // A doubled `s` is a keystroke slip, not a plural: `thiss` → `this` should
    // still be corrected.
    if stem.ends_with('s') {
        return false;
    }

    // The correction is just the word minus its plural `s`.
    if stem == correction {
        return true;
    }

    // Consonant + `ys`: the English plural is `-ies`, which is two edits away and
    // therefore unreachable. `companys`, `storys`, `partys` — but not `boys`,
    // `days`, `keys`, where `y` follows a vowel and the plural really is `-ys`.
    if let Some(before_y) = stem.strip_suffix('y') {
        if before_y
            .chars()
            .next_back()
            .is_some_and(|c| !matches!(c, 'a' | 'e' | 'i' | 'o' | 'u'))
        {
            return true;
        }
    }
    false
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

    /// The corpus the DOMINANCE threshold is tuned against.
    ///
    /// Both previous thresholds were chosen by argument and both were wrong. This
    /// is the guard: change the weights or the threshold and these say whether the
    /// change was an improvement or just a different set of failures.
    #[test]
    fn typo_corpus_is_corrected() {
        let d = dict();
        for (typo, want) in [
            // Transpositions — the commonest typing error.
            ("teh", "the"),
            ("adn", "and"),
            ("recieve", "receive"),
            ("thier", "their"),
            ("waht", "what"),
            // Doubled keystroke.
            ("usee", "use"),
            // Plain misspellings.
            ("seperate", "separate"),
            ("definately", "definitely"),
            ("occured", "occurred"),
        ] {
            assert_eq!(
                d.suggest(typo, 3).as_deref(),
                Some(want),
                "{typo} should correct to {want}"
            );
        }
    }

    /// The other half of the corpus: things that must NOT be touched. A threshold
    /// that fixes more typos by also rewriting these is not an improvement.
    #[test]
    fn correct_and_ambiguous_words_are_left_alone() {
        let d = dict();
        for w in [
            // Ordinary words.
            "quick", "brown", "keyboard", "correction", "the", "and", "use",
            // Real-word errors: both are words, so this engine cannot see them.
            // Phase 5's job, not a regression.
            "form", "there", "your",
        ] {
            assert_eq!(d.suggest(w, 3), None, "{w} must not be rewritten");
        }
    }

    #[test]
    fn intended_plurals_are_not_made_singular() {
        let d = dict();
        // `company` is one edit away and `companies` is two, so edit distance can
        // only ever offer the singular — which changes the meaning of the sentence.
        assert_eq!(d.suggest("companys", 3), None);
        assert_eq!(d.suggest("storys", 3), None);

        assert!(looks_like_intended_plural("companys", "company"));
        // Any word whose correction is just itself minus a trailing `s` is being
        // made singular, and that changes meaning — `boys` → `boy` included. (Real
        // plurals never reach this: they are dictionary words and return at
        // distance 0 long before.)
        assert!(looks_like_intended_plural("boys", "boy"));

        // A doubled `s` is a keystroke slip, not a plural, and must still correct.
        assert!(!looks_like_intended_plural("thiss", "this"));
        assert_eq!(d.suggest("thiss", 3).as_deref(), Some("this"));
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

    /// Diagnostic, not an assertion. `cargo test probe_candidates -- --nocapture`
    /// prints what SymSpell actually returns, so tuning arguments are made against
    /// real numbers rather than guesses.
    #[test]
    fn probe_candidates() {
        let d = dict();
        for w in ["usee", "companys", "teh", "recieve", "cta", "adn", "thier", "definately"] {
            let mut hits = d.sym.lookup(w, Verbosity::Closest, MAX_EDIT_DISTANCE);
            // Sort exactly as `suggest` does — the raw lookup order is not ranked.
            hits.sort_by(|a, b| a.distance.cmp(&b.distance).then(b.count.cmp(&a.count)));
            let verdict = d.suggest(w, 3);
            println!("\n{w:?} -> {verdict:?}   ({} candidates)", hits.len());
            for h in hits.iter().take(4) {
                println!("    {:<12} dist={} count={}", h.term, h.distance, h.count);
            }
            if hits.len() > 1 {
                let ratio = hits[0].count as f64 / hits[1].count.max(1) as f64;
                println!("    top/runner-up = {ratio:.2}x (need {DOMINANCE}x)");
            }
        }
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
