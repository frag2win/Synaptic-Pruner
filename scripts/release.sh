#!/bin/bash
set -e

echo "Running pre-publish checks..."

# 1. Check if the working tree is clean
if [ -n "$(git status --porcelain)" ]; then
    echo "ERROR: Working tree is not clean. Please commit or stash your changes before publishing."
    exit 1
fi

# 2. Check if HEAD matches origin/main
git fetch origin main || echo "Warning: could not fetch origin/main"
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
    echo "ERROR: Local HEAD does not match origin/main. Please pull/push your changes first."
    exit 1
fi

# 3. Check if a git tag exists for the current version
VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
if ! git rev-parse "$TAG" >/dev/null 2>&1; then
    echo "ERROR: Tag $TAG does not exist. Please tag the release first:"
    echo "git tag -a $TAG -m \"Release $TAG\""
    echo "git push origin $TAG"
    exit 1
fi

if [ "$(git rev-parse HEAD)" != "$(git rev-parse "$TAG^{commit}")" ]; then
    echo "ERROR: Tag $TAG does not point to the current HEAD."
    exit 1
fi

echo "Pre-publish checks passed!"
# Execute the actual rote registry play push
# Ensure Rote CLI is in path (WSL environment)
wsl -d Ubuntu -- /bin/bash -c "export PATH=/home/shubham_pawar/.local/bin:\$PATH && rote registry play push ~/.rote/flows/setup-express-workspace/main.ts frag2win"
