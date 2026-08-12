# Forked NSIS installer template

`installer.nsi` is a **fork of Tauri's own NSIS template**, carrying one addition:
an "Optional features" page with the system-wide autocorrect opt-in checkbox.

It is wired up by `tauri.conf.json` → `bundle.windows.nsis.template`.

## Why a fork

Tauri 2's NSIS template has no Components page, and both of its finish-page
checkbox slots are already spoken for (`MUI_FINISHPAGE_SHOWREADME` → desktop
shortcut, `MUI_FINISHPAGE_RUN` → launch app). `bundle.windows.nsis.template` is
the only supported way to add a page.

There *is* a lighter alternative if this fork ever becomes a burden: Tauri
includes the `installerHooks` `.nsh` at **line 28 of the upstream template**, above
all page definitions, so a hook file can legally declare `Page custom`. The catch
is ordering — a page declared there lands **before** the Welcome page, which reads
badly. That is the only reason this is a fork and not a hook.

## Provenance

| | |
|---|---|
| Upstream | `crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi` |
| Tag | `tauri-cli-v2.10.1` (matches the `@tauri-apps/cli` in `package.json`) |
| Pristine copy | `installer.upstream.nsi` — **do not edit** |

## Upgrading Tauri

The pristine copy exists so this stays a mechanical three-way merge rather than
an archaeology exercise:

```sh
# 1. Fetch the new upstream template (replace the tag)
curl -sSL -o /tmp/new-upstream.nsi \
  "https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v<NEW>/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi"

# 2. See exactly what upstream changed
diff installer.upstream.nsi /tmp/new-upstream.nsi

# 3. See exactly what we changed (three hunks, all marked "R3WRITE PATCH")
diff installer.upstream.nsi installer.nsi

# 4. Re-apply our hunks onto the new upstream, then refresh the pristine copy
cp /tmp/new-upstream.nsi installer.upstream.nsi
```

**Pay attention to WebView2 bootstrap changes** in step 2. That is the part of the
template that would actually hurt if it silently drifted — a stale bootstrapper
means a broken install on a machine without WebView2, which is exactly the machine
least able to diagnose it.

## Our changes

All three hunks are commented `R3WRITE PATCH`:

1. `!include "nsDialogs.nsh"` alongside the other includes.
2. The **Optional features** page — `AutocorrectPageCreate` / `AutocorrectPageLeave`,
   inserted between the directory and start-menu pages. Checkbox defaults to
   **unchecked**; a feature that reads keystrokes is never pre-ticked.
3. A `WriteRegDWORD` in `Section Install` recording the choice.

## The registry key

```
HKCU\Software\R3write : AutocorrectOptIn (DWORD, 0 or 1)
```

Deliberately **not** `Software\${MANUFACTURER}\${PRODUCTNAME}`: `bundle.publisher`
is unset, so `MANUFACTURER` is derived by Tauri and could change under us — after
which the app would read `false` forever with nothing to show for it.

HKCU rather than HKLM because this is a per-user preference, and an all-users
install may run elevated as a different account than the one that will use the app.

Read from Rust by `autocorrect_installer_opt_in` in
`src/autocorrect/mod.rs`. **If you change the key, change both.**

It is a *preference*, not a switch: it seeds the first-run default in Settings.
The keyboard hook still requires an active license *and* an explicit enabled
config, so ticking the box in the installer cannot by itself start monitoring
keystrokes.
