# Refactor #348: Commit and Test Script
# Run this script from the vellar-dapp directory
# Usage: .\refactor-348-commit-and-test.ps1

$ErrorActionPreference = "Continue"
$workspaceRoot = "c:\Users\Nuelthewave\Desktop\VELLAR\vellar-dapp"

Write-Host ""
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "Refactor #348: Origin-Validation Consolidation" -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host ""

# Change to workspace directory
Set-Location $workspaceRoot

# Step 1: Check git status
Write-Host "[Step 1] Checking git status..." -ForegroundColor Yellow
git status --short
Write-Host ""

# Step 2: Stage changes
Write-Host "[Step 2] Staging all changes..." -ForegroundColor Yellow
git add .
if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ Changes staged" -ForegroundColor Green
} else {
    Write-Host "⚠ Warning: git add returned non-zero exit code" -ForegroundColor Yellow
}
Write-Host ""

# Step 3: Verify staged changes
Write-Host "[Step 3] Verifying staged changes..." -ForegroundColor Yellow
git diff --cached --name-only
Write-Host ""

# Step 4: Create commit
Write-Host "[Step 4] Creating commit..." -ForegroundColor Yellow
$commitMessage = "refactor(#348): consolidate origin-validation via permission-service facade"
git commit -m $commitMessage
if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ Commit created successfully" -ForegroundColor Green
} else {
    Write-Host "⚠ Commit may have failed or no changes to commit" -ForegroundColor Yellow
}
Write-Host ""

# Step 5: Show recent commits
Write-Host "[Step 5] Showing recent commits..." -ForegroundColor Yellow
git log --oneline -5
Write-Host ""

# Step 6: Run extension tests
Write-Host "[Step 6] Running extension tests..." -ForegroundColor Yellow
pnpm test --filter=@vellar/extension -- --run
if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ Extension tests passed" -ForegroundColor Green
} else {
    Write-Host "⚠ Extension tests may have failed. Check output above." -ForegroundColor Yellow
}
Write-Host ""

# Step 7: Run permission-service tests
Write-Host "[Step 7] Running permission-service tests..." -ForegroundColor Yellow
pnpm test --filter=@vellar/permission-service -- --run
if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ Permission-service tests passed" -ForegroundColor Green
} else {
    Write-Host "⚠ Permission-service tests may have failed. Check output above." -ForegroundColor Yellow
}
Write-Host ""

# Step 8: Final git status
Write-Host "[Step 8] Final git status..." -ForegroundColor Yellow
git status
Write-Host ""

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "Refactor #348 commit and test process complete!" -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  - Review test output above" -ForegroundColor Cyan
Write-Host "  - If tests pass, you're ready to push the branch" -ForegroundColor Cyan
Write-Host "  - See REFACTOR_348_IMPLEMENTATION.md for full details" -ForegroundColor Cyan
Write-Host ""
