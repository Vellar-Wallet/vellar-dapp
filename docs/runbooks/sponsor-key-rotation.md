# Sponsor key rotation and Render account recovery

See `docs/decisions.md` ("SPOF triage, issue #474") for why this exists and
what it does and does not solve.

The files, flags, environment keys and code behaviour this runbook relies on are
checked in CI by `pnpm check:runbooks` (`scripts/runbook-freshness.ts`): if one
is renamed, removed or changes meaning, the check fails and names the stale
step. Update this runbook in the same change. The reference to `docs/decisions.md`
is the one thing it cannot check, because that file is gitignored.

## Sponsor key rotation

The sponsor secret key (`SPONSOR_SECRET_KEY` / `SPONSOR_PUBLIC_KEY`, set in the
Render dashboard per `render.yaml`, never committed) is the funding path for
wallet creation and sponsored submission in `services/wallet-service`. Rotate
it on a suspected compromise, or on a routine schedule if one is later adopted.

1. **Generate a new Stellar keypair** for the sponsor account, on the correct
   network (mainnet, per the 2026-09-20 cutover — see `render.yaml`'s own
   header comment).
2. **Fund the new account** before cutting over — an underfunded new sponsor
   fails closed (the spend budget in `packages/service-kit/src/budget.ts`
   requires the account to actually hold what it claims to spend; a starved
   sponsor does not silently degrade to unmetered spending, it refuses).
3. **Verify the new key before deploying it**, exactly as `render.yaml` itself
   instructs:
   ```
   tsx scripts/verify-signing-keys.ts --network mainnet --sponsor G<new-public-key>
   ```
   This confirms the secret actually signs as the claimed public key and that
   the public key matches the declared network — `verifySigningKeys` in
   `services/wallet-service/src/index.ts` runs this same check at every boot
   and refuses to start on a mismatch, so a bad rotation fails at deploy time,
   not silently in production.
4. **Update `SPONSOR_SECRET_KEY` / `SPONSOR_PUBLIC_KEY` in the Render
   dashboard** for both `wallet-service` and `policy-service` (both consume
   the same sponsor identity — see each service's use of
   `signingKeyFromEnv("sponsor")`).
5. **Redeploy manually** — `render.yaml` disables `autoDeploy` deliberately
   (M9/FIX 11: no unreviewed commit ships with live signing keys before CI is
   green), so a manual deploy is required to pick up the new secret.
6. **Confirm the boot log** shows the new sponsor key confirmed on-chain
   (`probeSigningKeysOnChain` logs `"<role> key <publicKey> confirmed on
   <network>"` at info level; a warning means the new account is not yet
   funded/found).
7. **Drain and retire the old key** once the new one is confirmed live:
   sweep any remaining balance to the new sponsor account, then the old
   secret is no longer sponsor-authoritative (it was never long-term custody
   for anything beyond the funding path).

## Render account recovery

If the Render account holding this deployment becomes inaccessible (lost
credentials, compromised account) and must be recreated from scratch:

1. Follow Render's own account-recovery flow for the lost account first;
   only recreate from scratch if that is genuinely unavailable.
2. If recreating: `render.yaml` is the full, current description of both
   services' topology (build/start commands, health checks, env var names,
   the `autoDeploy: false` gate, and the free-Postgres caveats). A fresh
   Render account can stand the same deployment back up by applying this
   blueprint — it is not a from-memory rebuild.
3. Re-provision the secrets `render.yaml` deliberately excludes
   (`RELAYER_API_KEY`, `SPONSOR_SECRET_KEY`, `SPONSOR_PUBLIC_KEY`) via the new
   dashboard; verify the sponsor key exactly as in step 3 above before the
   first deploy.
4. Re-point DNS at the new deployment's URL (see `docs/decisions.md`: DNS
   itself is a separate, currently unmitigated single point of failure this
   runbook does not solve).
5. If the free Postgres also needs recreating, see issue #475's own scope
   (`docs/decisions.md` and the database migration work tracked there) —
   this runbook covers the compute/deploy side only, not the data migration.
