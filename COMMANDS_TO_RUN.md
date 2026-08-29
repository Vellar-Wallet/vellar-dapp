# Git Operations to Complete

Run these commands in sequence from the vellar-dapp directory:

## 1. Stage all changes
```bash
git add .
```

## 2. Create commit
```bash
git commit -m "refactor(#348): consolidate origin-validation via permission-service facade"
```

## 3. Show git log to confirm
```bash
git log --oneline -5
```

## 4. Run full test suite
```bash
pnpm test
```

## 5. Final Status Check
```bash
git log -1
git status
```

---

## Modified Files (as of last status check):
- apps/extension/lib/router.ts
- apps/extension/package.json
- services/permission-service/src/index.ts
