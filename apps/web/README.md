# @vellar/web

Primary product surface (technical-doc.md §4.1, §12): onboarding, passkey registration/recovery, wallet dashboard, advanced transaction review, policy builder, verification console, cleanup wizard, device/session management.

Stack (idea.md §7): Next.js, React, TypeScript, Tailwind, Zustand, React Hook Form + Zod, TanStack Query.

## Feature flags

`lib/feature-flags.ts` gates a UI behind a gradual rollout — an allowlist of
`accountId`s that always see it, plus a percentage rollout bucketed by a
stable hash of `accountId` (so the same account always gets the same
experience across page loads). Configured via `NEXT_PUBLIC_FLAG_*` env vars,
inlined at build time like every other client config value in
`lib/config.ts`. Currently gates the policy builder (`app/policies/page.tsx`,
flag name `policyBuilderV2`):

```
NEXT_PUBLIC_FLAG_POLICY_BUILDER_V2_ROLLOUT_PERCENT=25   # 0-100, default 0
NEXT_PUBLIC_FLAG_POLICY_BUILDER_V2_ALLOWLIST=GACCT1,GACCT2
```

See `docs/decisions.md` (gitignored — private strategy doc, see repo root
`.gitignore`) for the full rollout plan and reasoning; the mechanism itself
is documented in `lib/feature-flags.ts` and tested in
`lib/feature-flags.test.ts` / `app/policies/page.flag-gating.test.tsx`.
