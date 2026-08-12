//! How likely is it that *this* typo produced *that* word?
//!
//! Edit distance treats every single-character edit as equally probable, and word
//! frequency alone then decides. That is wrong about how people actually type, and
//! it was measurably wrong here: `usee` offered `use` (720M) and `see` (681M) —
//! statistically a coin flip, so nothing fired — even though one is a doubled
//! keystroke and the other swaps a word-initial `u` for an `s`, keys on opposite
//! sides of the keyboard.
//!
//! Real typing errors are dominated by a few mechanical shapes. Weighting
//! candidates by which shape produced them separates `use` from `see` on evidence
//! rather than on a 1.06x frequency difference.

/// The mechanical shape of the edit between what was typed and a candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditShape {
    /// Two adjacent characters swapped: `adn` → `and`, `teh` → `the`.
    /// The single most common typing error there is.
    Transposition,
    /// A character typed twice: `usee` → `use`. Key bounce or a slow release.
    DoubledLetter,
    /// A character substituted for a neighbouring key: `wprd` → `word`.
    AdjacentKey,
    /// A character missed: `wrd` → `word`.
    OmittedLetter,
    /// A character inserted that is not a doubling: `worrd` → `word`.
    ExtraLetter,
    /// Anything else — arbitrary substitutions, two-edit distances.
    Other,
}

impl EditShape {
    /// Multiplier applied to a candidate's corpus frequency.
    ///
    /// The spread matters more than the absolute values: it has to be wide enough
    /// to overcome frequency gaps between common words (`use` vs `see` differ by
    /// only 6%) without letting an arbitrary substitution beat a genuinely more
    /// common word.
    pub fn weight(self) -> u64 {
        match self {
            EditShape::Transposition | EditShape::DoubledLetter => 20,
            EditShape::AdjacentKey => 6,
            EditShape::OmittedLetter => 3,
            EditShape::ExtraLetter => 2,
            EditShape::Other => 1,
        }
    }
}

/// Classify the edit that turns `typed` into `candidate`. Both must be lowercase.
pub fn classify_edit(typed: &str, candidate: &str) -> EditShape {
    let t: Vec<char> = typed.chars().collect();
    let c: Vec<char> = candidate.chars().collect();

    match t.len() as i64 - c.len() as i64 {
        0 => same_length(&t, &c),
        // Typed one character too many.
        1 => match extra_index(&t, &c) {
            // A doubled key is a far stronger signal than an arbitrary insertion,
            // so the two are distinguished rather than lumped together.
            Some(i) if is_doubling(&t, i) => EditShape::DoubledLetter,
            Some(_) => EditShape::ExtraLetter,
            None => EditShape::Other,
        },
        // Typed one character too few.
        -1 => {
            if extra_index(&c, &t).is_some() {
                EditShape::OmittedLetter
            } else {
                EditShape::Other
            }
        }
        _ => EditShape::Other,
    }
}

fn same_length(t: &[char], c: &[char]) -> EditShape {
    let diffs: Vec<usize> = (0..t.len()).filter(|&i| t[i] != c[i]).collect();
    match diffs.len() {
        // Adjacent swap.
        2 if diffs[1] == diffs[0] + 1
            && t[diffs[0]] == c[diffs[1]]
            && t[diffs[1]] == c[diffs[0]] =>
        {
            EditShape::Transposition
        }
        1 if adjacent_on_qwerty(t[diffs[0]], c[diffs[0]]) => EditShape::AdjacentKey,
        _ => EditShape::Other,
    }
}

/// If `long` is `short` with exactly one character inserted, which index is it?
fn extra_index(long: &[char], short: &[char]) -> Option<usize> {
    let mut i = 0;
    while i < short.len() && long[i] == short[i] {
        i += 1;
    }
    // The remainder must line up once the extra character is skipped.
    if long[i + 1..] == short[i..] {
        Some(i)
    } else {
        None
    }
}

/// Whether the character at `i` repeats one of its neighbours.
fn is_doubling(t: &[char], i: usize) -> bool {
    (i > 0 && t[i] == t[i - 1]) || (i + 1 < t.len() && t[i] == t[i + 1])
}

/// QWERTY neighbours, used to spot a slipped finger. Rows only — including
/// diagonals roughly doubles the table for little gain, since the vertical
/// neighbours are the ones people actually hit.
fn adjacent_on_qwerty(a: char, b: char) -> bool {
    const ROWS: [&str; 3] = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
    const COLS: [&str; 10] = [
        "qaz", "wsx", "edc", "rfv", "tgb", "yhn", "ujm", "ik", "ol", "p",
    ];
    let neighbours = |group: &str, a: char, b: char| {
        let g: Vec<char> = group.chars().collect();
        g.windows(2).any(|w| (w[0] == a && w[1] == b) || (w[0] == b && w[1] == a))
    };
    ROWS.iter().any(|r| neighbours(r, a, b)) || COLS.iter().any(|c| neighbours(c, a, b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transpositions_are_recognised() {
        assert_eq!(classify_edit("adn", "and"), EditShape::Transposition);
        assert_eq!(classify_edit("teh", "the"), EditShape::Transposition);
        assert_eq!(classify_edit("cta", "cat"), EditShape::Transposition);
        assert_eq!(classify_edit("recieve", "receive"), EditShape::Transposition);
    }

    #[test]
    fn doubled_letters_are_distinguished_from_other_insertions() {
        // The distinction that makes `usee` resolvable: dropping a repeated key is
        // a mechanical slip, inserting an unrelated character is not.
        assert_eq!(classify_edit("usee", "use"), EditShape::DoubledLetter);
        assert_eq!(classify_edit("worrd", "word"), EditShape::DoubledLetter);
        // Inserting a character that does not repeat a neighbour is a weaker
        // signal, and scores accordingly.
        assert_eq!(classify_edit("wolrd", "word"), EditShape::ExtraLetter);
        assert!(EditShape::DoubledLetter.weight() > EditShape::ExtraLetter.weight());
    }

    #[test]
    fn missing_and_extra_characters() {
        // Direction matters. Typing too few characters is an omission...
        assert_eq!(classify_edit("wrd", "word"), EditShape::OmittedLetter);
        // ...and typing too many is an insertion. `usee` → `see` means the user
        // typed a stray `u`, which is a weaker hypothesis than the doubled `e`
        // that yields `use` — the whole reason `usee` was previously a coin flip.
        assert_eq!(classify_edit("usee", "see"), EditShape::ExtraLetter);
    }

    #[test]
    fn adjacent_keys_beat_arbitrary_substitutions() {
        assert_eq!(classify_edit("wprd", "word"), EditShape::AdjacentKey);
        // `u` and `s` are nowhere near each other — this is the edit that must NOT
        // be allowed to compete with a doubled letter on frequency alone.
        assert_eq!(classify_edit("usee", "asee"), EditShape::Other);
        assert_eq!(classify_edit("xyz", "word"), EditShape::Other);
    }

    #[test]
    fn unrelated_words_score_lowest() {
        assert_eq!(classify_edit("cat", "dog"), EditShape::Other);
        assert_eq!(classify_edit("abc", "abcdef"), EditShape::Other);
    }

    #[test]
    fn typo_shapes_outweigh_a_narrow_frequency_lead() {
        // The `usee` case in numbers: `see` is only 6% less common than `use`, so
        // frequency alone cannot choose. Shape can.
        let use_score = 719_980_257u64 * classify_edit("usee", "use").weight();
        let see_score = 681_410_380u64 * classify_edit("usee", "see").weight();
        assert!(
            use_score > see_score * 3,
            "doubled-letter must decisively beat a distant substitution"
        );
    }
}
