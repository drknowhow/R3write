# Autocorrect — Phase 0 spike results

This gates the whole feature. Nothing in Phase 1+ gets built until this table is
filled in, because the apps that pass here **become the shipped allowlist** and the
ones that fail are refused by design rather than fixed later.

Run: `cd src-tauri && cargo run --example spike_hook`

Then type **`teh `** (with the trailing space) into each target below.
Expected: it becomes `the `.

> The pass criterion is the **resulting text and the undo stack**, not whether the
> keystrokes were delivered. Every interesting failure happens after delivery.

## Matrix

| App | Text correct? | One Ctrl+Z undoes it? | Completion popup interfered? | App transform raced us? | Verdict |
|---|---|---|---|---|---|
| Notepad | | | n/a | n/a | |
| Word | | | | Word autocorrect | |
| Chrome — address bar | | | omnibox suggestions | | |
| Chrome — textarea | | | | | |
| Slack | | | emoji/@ autocomplete | markdown | |
| VS Code | | | IntelliSense | | |
| Windows Terminal | | | | | expect FAIL — refused by design |

Browsers and Electron apps are worth testing now that the UIA password probe exists
(Phase 1b). They are safe to *allow*; what is unproven is whether replacement
survives their autocomplete. Test with a completion popup deliberately open.

| App | Text correct? | One Ctrl+Z undoes it? | Autocomplete interfered? | Verdict |
|---|---|---|---|---|
| Chrome — textarea | | | | |
| Chrome — address bar | | | omnibox suggestions | |
| Slack — message box | | | emoji/@ autocomplete | |
| VS Code — editor | | | IntelliSense | |

Also confirm password suppression actually fires:

- [ ] Chrome password field → nothing captured, no correction
- [ ] Windows login/UAC prompt → nothing captured
- [ ] Tab from a username box straight into a password box in the same page →
      suppression engages **without** the window changing

## Unicode cases

`N chars != N backspaces` for graphemes. The spike uses `.chars().count()` on
purpose so this breaks visibly rather than silently.

| Input | Expected | Actual | Notes |
|---|---|---|---|
| `tehé ` | | | accented char |
| `teh👍 ` | | | astral plane / surrogate pair |

## Injection tagging

- [ ] stderr shows committed words while typing in a normal app
- [ ] the correction does **not** re-enter the buffer (no cascade, no loop)
- [ ] typing in R3write's own quick-edit prompt is visible in stderr
      → confirms the own-process exclusion is still TODO for Phase 1
- [ ] `LLKHF_LOWER_IL_INJECTED` observed? (only matters if running at mixed integrity)

## Gate

**If replacement is unreliable in more than one of Word / Chrome / Slack — stop and
re-plan before Phase 1.** The bubble, settings, and log are all worthless without a
reliable replacement primitive.

Outcome: _______________  Date: _______________

Apps that passed (→ initial allowlist): _______________________________________

---

Delete `src-tauri/examples/spike_hook.rs` once this is recorded. Keep this file.
