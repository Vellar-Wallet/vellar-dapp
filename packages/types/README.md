# @vellar/types

Shared domain types for wallet, policy, verification, and lifecycle modules.

## Breaking-change convention

Any change that removes a field, narrows a type, or renames an exported symbol
in this package is a **breaking change** and must be annotated with a `BREAKING:`
comment in the source file. This makes it easy for consumers to understand why
something broke when reading the diff or the source.

### Format

Place a `// BREAKING:` comment directly above or within the changed declaration:

```ts
// BREAKING: removed `lastActiveAt` in v2 — consumers must use `createdAt` only.
export interface WalletSession {
  accountId: string;
  network: Network;
  connected: boolean;
  authMethod: "passkey";
  createdAt: string;
}
```

### Enforcement

The `check-breaking-changes.mjs` script validates that any removed or narrowed
exported type in a git diff has an accompanying `BREAKING:` comment. Run it
before submitting a PR:

```bash
node scripts/check-breaking-changes.mjs
```

Or add it to CI as a pre-merge check. The script accepts optional `--base <ref>`
and `--staged` flags (default: compare working tree against `HEAD`).
