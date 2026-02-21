# Git Merge Instructions (Conflict-Free)

Run these commands in order from the project root:

```bash
# 1. Ensure .gitignore excludes build artifacts
# (.gitignore already includes: node_modules, dist, .env, *.log, .DS_Store)

# 2. Pull latest from remote first (avoids merge conflicts)
git stash push -u -m "WIP before merge"
git pull origin main
git stash pop

# 3. Add source files only (excludes node_modules, dist via .gitignore)
git add .gitignore package.json package-lock.json index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json components.json
git add src/
git add public/
git add scripts/ 2>/dev/null || true
git add server/ 2>/dev/null || true

# 4. Check what will be committed
git status

# 5. Commit
git commit -m "feat: Police Portal, area-wise stations, 2km ranges, scraper script"

# 6. Pull again (in case remote changed during commit)
git pull origin main --no-edit

# 7. Push
git push origin main
```

**If conflicts occur during `git stash pop` or `git pull`:**
- Resolve conflicts in the reported files
- `git add <resolved-files>`
- `git rebase --continue` (if rebasing) or `git commit` (if merging)
