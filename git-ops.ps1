#!/usr/bin/env pwsh

# Stage all changes
Write-Host "Staging all changes..."
git add .
Write-Host "Staged files:"
git diff --cached --name-only

# Create commit
Write-Host "`nCreating commit..."
git commit -m "refactor(#348): consolidate origin-validation via permission-service facade"

# Show git log
Write-Host "`nGit log (last 5 commits):"
git log --oneline -5

# Run tests
Write-Host "`nRunning test suite..."
pnpm test
