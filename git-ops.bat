@echo off
cd /d "c:\Users\Nuelthewave\Desktop\VELLAR\vellar-dapp"

echo.
echo === Staging all changes ===
git add .

echo.
echo === Showing staged files ===
git diff --cached --name-only

echo.
echo === Creating commit ===
git commit -m "refactor(#348): consolidate origin-validation via permission-service facade"

echo.
echo === Git log (last 5 commits) ===
git log --oneline -5

echo.
echo === Running test suite ===
pnpm test

pause
