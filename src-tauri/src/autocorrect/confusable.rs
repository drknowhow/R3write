//! Which words are worth asking a language model about.
//!
//! The dictionary cannot see real-word errors: `form` for `from`, `their` for
//! `there`. Both are correctly spelled, so `suggest` returns at distance 0 and the
//! sentence stays wrong. Only context resolves them.
//!
//! But context costs a network round-trip, real money, and — the part that
//! matters — it means keystrokes leave the machine. So arbitration is **not**
//! offered for every word. It fires only where a local signal says the word is
//! plausibly wrong despite being spelled correctly:
//!
//! 1. the word belongs to a known confusable set, or
//! 2. the dictionary suppressed a correction because it looked like an intended
//!    plural (`companys`), which needs morphology rather than edit distance.
//!
//! In ordinary prose that is on the order of one word in a few hundred, which
//! keeps both the bill and the exposure small.

/// Groups of words people genuinely swap for one another.
///
/// Deliberately short. Every entry here is a word that will be sent off the
/// machine when it is typed and LLM assist is on, so the bar is "people really do
/// confuse these", not "these look similar".
const CONFUSABLES: &[&[&str]] = &[
    &["their", "there", "theyre"],
    &["your", "youre"],
    &["its", "it's"],
    &["form", "from"],
    &["then", "than"],
    &["to", "too", "two"],
    &["affect", "effect"],
    &["lose", "loose"],
    &["weather", "whether"],
    &["accept", "except"],
    &["advice", "advise"],
    &["principal", "principle"],
    &["complement", "compliment"],
    &["stationary", "stationery"],
    &["discreet", "discrete"],
    &["ensure", "insure"],
    &["everyday", "every day"],
    &["into", "in to"],
    &["breath", "breathe"],
    &["choose", "chose"],
    &["quite", "quiet"],
    &["desert", "dessert"],
    &["personal", "personnel"],
    &["led", "lead"],
    &["past", "passed"],
    &["role", "roll"],
    &["site", "sight", "cite"],
    &["waist", "waste"],
    &["whose", "whos"],
];

/// Whether this word is worth spending a context lookup on.
pub fn is_confusable(word: &str) -> bool {
    let lower = word.to_lowercase();
    CONFUSABLES
        .iter()
        .any(|group| group.iter().any(|w| *w == lower))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_confusables_are_flagged() {
        for w in ["their", "There", "form", "from", "then", "than", "its"] {
            assert!(is_confusable(w), "{w} should be eligible for arbitration");
        }
    }

    #[test]
    fn ordinary_words_are_not() {
        // The cost control: if this ever starts returning true broadly, every word
        // typed begins leaving the machine.
        for w in ["keyboard", "correction", "the", "and", "company", "autocorrect"] {
            assert!(!is_confusable(w), "{w} must not trigger a network call");
        }
    }
}
