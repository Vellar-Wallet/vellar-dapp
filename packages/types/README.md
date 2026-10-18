# @vellar/types

Shared domain types for wallet, policy, verification, and lifecycle modules.

## Breaking Change Comment Convention (`BREAKING:`)

Because `@vellar/types` is consumed across `apps/web`, `apps/extension`, SDK packages, and backend services, any breaking change to an exported type or interface must be explicitly annotated in the diff with a `BREAKING:` comment:

```ts
// BREAKING: Removed legacy field `foo` from WalletSession; use `serverSessionId` instead.
```

### What Counts as a Breaking Change

The `checkBreakingTypeChanges` / `assertBreakingChangeComment` validator in [`src/breaking-change-check.ts`](./src/breaking-change-check.ts) flags:

1. **Removed exports** (`removed_export`): Deleting or renaming an exported `type` or `interface`.
2. **Narrowed unions** (`narrowed_union`): Removing a variant from an exported union type (e.g., removing `"mainnet"` from `Network`).
3. **Incompatible type alias changes** (`changed_type_alias`): Changing an exported type alias definition incompatibly.
4. **Removed interface properties** (`removed_interface_property`): Removing a field from an exported `interface`.
5. **Optional property made required** (`optional_property_made_required`): Removing `?` from an existing property on an exported `interface`.
6. **Narrowed or altered property types** (`changed_interface_property_type`): Changing or narrowing the type of an existing interface property.

Additive changes (adding new exported types, adding new union members, or adding new optional `?` properties to existing interfaces) are non-breaking and do not require a `BREAKING:` comment.
