#!/bin/bash
# Run this script once from inside the project folder to push to GitHub.
# It expects you to be logged in to GitHub (git credentials cached or SSH set up).
set -e

REPO="https://github.com/alexandrubogdan-sketch/progress-partners-risk.git"

git init
git add .
git commit -m "Initial commit: Progress Partners Risk dashboard"
git branch -M main
git remote add origin "$REPO"
git push -u origin main

echo ""
echo "✅ Pushed to $REPO"
echo "Next: go to https://vercel.com/new and import this repo."
