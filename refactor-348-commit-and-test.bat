@echo off
REM Refactor #348: Commit and Test Script
REM Run this batch file from the vellar-dapp directory

echo.
echo ===================================================
echo Refactor #348: Origin-Validation Consolidation
echo ===================================================
echo.

REM Change to workspace directory
cd /d c:\Users\Nuelthewave\Desktop\VELLAR\vellar-dapp

echo [Step 1] Checking git status...
git status --short
echo.

echo [Step 2] Staging all changes...
git add .
echo.

echo [Step 3] Verifying staged changes...
git diff --cached --name-only
echo.

echo [Step 4] Creating commit...
git commit -m "refactor(#348): consolidate origin-validation via permission-service facade"
echo.

echo [Step 5] Showing recent commits...
git log --oneline -5
echo.

echo [Step 6] Running extension tests...
pnpm test --filter=@vellar/extension -- --run
if errorlevel 1 (
    echo WARNING: Extension tests may have failed. Check output above.
) else (
    echo Extension tests passed!
)
echo.

echo [Step 7] Running permission-service tests...
pnpm test --filter=@vellar/permission-service -- --run
if errorlevel 1 (
    echo WARNING: Permission-service tests may have failed. Check output above.
) else (
    echo Permission-service tests passed!
)
echo.

echo [Step 8] Final git status...
git status
echo.

echo ===================================================
echo Refactor #348 commit and test process complete!
echo ===================================================
echo.
echo Next steps:
echo - Review test output above
echo - If tests pass, you're ready to push the branch
echo - See REFACTOR_348_IMPLEMENTATION.md for full details
echo.

pause
