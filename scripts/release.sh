#!/usr/bin/env bash
set -euo pipefail

bump_type="${1:?Usage: scripts/release.sh patch|minor|major}"

if [[ "$bump_type" != "patch" && "$bump_type" != "minor" && "$bump_type" != "major" ]]; then
    echo "Error: argument must be patch, minor, or major (got: $bump_type)" >&2
    exit 1
fi

if [[ "$(git branch --show-current)" != "main" ]]; then
    echo "Error: releases must be created from the main branch." >&2
    exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
    echo "Error: the working tree must be clean before releasing." >&2
    exit 1
fi

git fetch origin main --tags

if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
    echo "Error: local main must match origin/main before releasing." >&2
    exit 1
fi

PACKAGE_VERSION=$(node -p 'require("./package.json").version')
LOCK_VERSION=$(node -p 'require("./package-lock.json").version')
LOCK_ROOT_VERSION=$(node -p 'require("./package-lock.json").packages[""].version')

if [[ "$PACKAGE_VERSION" != "$LOCK_VERSION" || "$PACKAGE_VERSION" != "$LOCK_ROOT_VERSION" ]]; then
    echo "Error: package.json version ($PACKAGE_VERSION) does not match package-lock.json versions ($LOCK_VERSION, $LOCK_ROOT_VERSION)." >&2
    exit 1
fi

NEXT_VERSION=$(
    node -e '
const [version, bump] = process.argv.slice(1);
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
if (!match) {
    console.error(`Error: unsupported package version: ${version}`);
    process.exit(1);
}
let [, major, minor, patch] = match.map(Number);
if (bump === "major") {
    major += 1;
    minor = 0;
    patch = 0;
} else if (bump === "minor") {
    minor += 1;
    patch = 0;
} else {
    patch += 1;
}
process.stdout.write(`${major}.${minor}.${patch}`);
' "$PACKAGE_VERSION" "$bump_type"
)
NEXT_TAG="v$NEXT_VERSION"
RELEASE_DATE=$(date +%Y-%m-%d)

if git rev-parse --quiet --verify "refs/tags/$NEXT_TAG" >/dev/null; then
    echo "Error: tag $NEXT_TAG already exists." >&2
    exit 1
fi

echo "Validating $NEXT_TAG"
npm ci
npm run lint
npm run typecheck
npm run compile
npm test --ignore-scripts
npm run package -- --out tryke-vscode.vsix

RELEASE_VERSION="$NEXT_VERSION" RELEASE_DATE="$RELEASE_DATE" node <<'NODE'
const fs = require("node:fs");

const path = "CHANGELOG.md";
const text = fs.readFileSync(path, "utf8");
const matches = [...text.matchAll(/^## Unreleased$/gm)];

if (matches.length !== 1) {
    console.error(`Error: expected one "## Unreleased" heading, found ${matches.length}.`);
    process.exit(1);
}

const marker = matches[0][0];
const markerStart = matches[0].index;
const notesStart = markerStart + marker.length;
const nextRelease = text.indexOf("\n## [", notesStart);

if (nextRelease === -1 || text.slice(notesStart, nextRelease).trim() === "") {
    console.error("Error: CHANGELOG.md has no notes in its Unreleased section.");
    process.exit(1);
}

const heading = `## Unreleased\n\n## [${process.env.RELEASE_VERSION}] - ${process.env.RELEASE_DATE}`;
const updated = text.slice(0, markerStart) + heading + text.slice(notesStart);
fs.writeFileSync(path, updated);
NODE

echo
echo "CHANGELOG.md updated. Edit it now, then press Enter to commit and release $NEXT_TAG."
echo "(Ctrl+C to abort at any time)"
read -r -p "Press Enter to continue: "

if ! grep -q "^## \\[$NEXT_VERSION\\] - $RELEASE_DATE$" CHANGELOG.md; then
    echo "Error: CHANGELOG.md no longer contains the expected $NEXT_TAG release heading." >&2
    exit 1
fi

npm version "$NEXT_VERSION" --no-git-tag-version

git add CHANGELOG.md package.json package-lock.json
git commit -m "release: $NEXT_TAG"
git tag "$NEXT_TAG"

git push origin HEAD
git push origin "$NEXT_TAG"
