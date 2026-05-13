# Merge to Main

Sync `dev` with `upstream/main`, then merge `dev` into `main` and push.

## Overview

This workflow helps you:
1. Check that `dev` is clean (no uncommitted changes)
2. Fetch and merge `upstream/main` into `dev`
3. Merge `dev` into `main`
4. Push both branches to `origin`

## Process

### 1) Check dev is clean

```bash
git checkout dev
git status --porcelain
# If any output, abort — dev must be clean before proceeding
```

If `git status --porcelain` produces any output, stop immediately. Do not proceed.

### 2) Fetch upstream/main and merge into dev

```bash
git fetch upstream main
git merge upstream/main --no-edit
```

### 3) Merge dev into main

```bash
git checkout main
git merge dev --no-edit
```

### 4) Push to origin

```bash
git push origin dev
git push origin main