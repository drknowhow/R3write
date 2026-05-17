#!/usr/bin/env bash
# scripts/release.sh — cut and publish an R3write release.
#
# Usage:
#   scripts/release.sh <version>
#
# Example:
#   scripts/release.sh 1.4.0
#
# What it does:
#   1. Sanity-checks: on main, clean tree, up to date with origin, tag is new.
#   2. Bumps package.json, tauri.conf.json, Cargo.toml to <version>.
#   3. Promotes the current [Unreleased] CHANGELOG section to [<version>] — today.
#   4. Extracts the new CHANGELOG section as release notes.
#   5. Builds the Tauri NSIS installer.
#   6. Commits the version bump, tags v<version>, pushes both.
#   7. Creates the GitHub release with BOTH the versioned and stable-named
#      installers attached so /releases/latest/download/R3write-setup.exe
#      keeps working across releases.
#
# Requires: bash, git, gh, npm, cargo, sed, awk on PATH.

set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") <version>

Example: $(basename "$0") 1.4.0

Run from anywhere inside the repo. Version must match X.Y.Z.

Before running, populate the [Unreleased] section in CHANGELOG.md with
the changes this release contains — that block becomes the GitHub release
notes verbatim.
EOF
  exit 1
}

[ $# -eq 1 ] || usage
VERSION="$1"

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "error: version must match X.Y.Z (got: $VERSION)" >&2
  exit 1
}

TAG="v$VERSION"
DATE="$(date +%F)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# ----- 1. Sanity checks ---------------------------------------------------

step() { printf '\n\033[1;35m→\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

step "Sanity-checking git state..."

CURRENT_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo "")"
[ "$CURRENT_BRANCH" = "main" ] || fail "must be on main (currently on '$CURRENT_BRANCH')"

if ! git diff --quiet || ! git diff --cached --quiet; then
  git status --short >&2
  fail "working tree has uncommitted changes — commit or stash first"
fi

git fetch origin main --quiet
LOCAL="$(git rev-parse @)"
REMOTE="$(git rev-parse @{u})"
[ "$LOCAL" = "$REMOTE" ] || fail "local main is not in sync with origin/main (run git pull / push first)"

if git rev-parse --verify --quiet "$TAG" >/dev/null; then
  fail "tag $TAG already exists locally"
fi
if git ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1; then
  fail "tag $TAG already exists on origin"
fi

for cmd in gh npm cargo awk sed; do
  command -v "$cmd" >/dev/null 2>&1 || fail "$cmd not found on PATH"
done

# ----- 2. Bump versions ---------------------------------------------------

step "Bumping versions to $VERSION..."

sed -i.bak -E "s/(\"version\"[[:space:]]*:[[:space:]]*)\"[^\"]+\"/\1\"$VERSION\"/" package.json
sed -i.bak -E "s/(\"version\"[[:space:]]*:[[:space:]]*)\"[^\"]+\"/\1\"$VERSION\"/" src-tauri/tauri.conf.json
sed -i.bak -E "s/^(version[[:space:]]*=[[:space:]]*)\"[^\"]+\"/\1\"$VERSION\"/" src-tauri/Cargo.toml
rm -f package.json.bak src-tauri/tauri.conf.json.bak src-tauri/Cargo.toml.bak

# Sanity check each one actually changed
for f in package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml; do
  grep -q "$VERSION" "$f" || fail "$f did not get the new version — bump aborted"
done

# ----- 3. Promote [Unreleased] in CHANGELOG -------------------------------

step "Promoting [Unreleased] → [$VERSION] in CHANGELOG..."

grep -q '^## \[Unreleased\]$' CHANGELOG.md || fail "CHANGELOG.md is missing the '## [Unreleased]' header"

awk -v ver="$VERSION" -v date="$DATE" '
  /^## \[Unreleased\]$/ {
    print
    print ""
    print "## [" ver "] - " date
    next
  }
  { print }
' CHANGELOG.md > CHANGELOG.md.tmp
mv CHANGELOG.md.tmp CHANGELOG.md

# ----- 4. Extract release notes ------------------------------------------

NOTES_FILE="$(mktemp -t r3write-release-notes-XXXXXX.md)"
trap 'rm -f "$NOTES_FILE" R3write-setup.exe' EXIT

awk -v ver="$VERSION" -v date="$DATE" '
  $0 == "## [" ver "] - " date { in_sec = 1; next }
  /^## \[/ { if (in_sec) exit }
  in_sec { print }
' CHANGELOG.md | sed -E '/./,$!d' > "$NOTES_FILE"  # strip leading blank lines

if [ ! -s "$NOTES_FILE" ]; then
  fail "release notes are empty — populate [Unreleased] in CHANGELOG before retrying"
fi

# ----- 5. Build the installer ---------------------------------------------

step "Building installer (cargo release build — typically 1-2 minutes)..."

npm run tauri:build

INSTALLER="src-tauri/target/release/bundle/nsis/R3write_${VERSION}_x64-setup.exe"
[ -f "$INSTALLER" ] || fail "installer not produced at $INSTALLER"

INSTALLER_SIZE=$(wc -c < "$INSTALLER")
printf '   built: %s (%s bytes)\n' "$INSTALLER" "$INSTALLER_SIZE"

# ----- 6. Commit, tag, push -----------------------------------------------

step "Committing version bump..."

git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock CHANGELOG.md
git commit -m "release: $VERSION"

step "Tagging $TAG..."

git tag -a "$TAG" -F "$NOTES_FILE"

step "Pushing main + tag..."

git push origin main
git push origin "$TAG"

# ----- 7. Create GitHub release with both assets --------------------------

step "Creating GitHub release..."

cp "$INSTALLER" R3write-setup.exe

gh release create "$TAG" \
  "$INSTALLER" \
  "R3write-setup.exe" \
  --title "R3write $VERSION" \
  --notes-file "$NOTES_FILE" \
  --latest

rm -f R3write-setup.exe

# ----- Done ---------------------------------------------------------------

printf '\n\033[1;32m✓\033[0m Released %s\n' "$VERSION"
printf '  https://github.com/drknowhow/R3write/releases/tag/%s\n' "$TAG"
