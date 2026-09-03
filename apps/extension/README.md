# @vellar/extension

Companion execution surface (technical-doc.md §4.2, §12): popup UI, background service worker, content/injection bridge, dApp connection approvals, transaction signing popup, account selector, permission management, deep-link handoff to web app.

Design principle: high-frequency wallet actions live here; advanced workflows route back to the web app. No silent signing; origin always displayed (technical-doc.md §8.2).

## Configuration

Build-time public env (WXT inlines `WXT_PUBLIC_*` into the client bundle):

- `WXT_PUBLIC_API_URL` — verification API gateway. Optional; defaults to the public gateway.
- `WXT_PUBLIC_WEB_APP_ORIGINS` — **comma-separated https origins allowed to pair** the extension (the Vellar web app). Only a listed origin can become the deep-link target and supply the paired wallet's `rpcUrl`.
  - A **production build** (`wxt build`) with this unset **refuses to enable pairing** — it fails closed rather than trusting an arbitrary origin. Set it for every production build.
  - A **dev build** (`wxt dev`) with this unset falls back to `http://localhost:3000` and `http://localhost:5173`.
- `WXT_PUBLIC_ALLOW_ANY_PAIR_ORIGIN` — set to `1` to explicitly disable the pair-origin restriction (any origin may pair). Named escape hatch only; logs a warning on every startup. **Never set this in a production build.**
- `WXT_PUBLIC_MAINNET_RPC_URL` — trusted Soroban RPC used to anchor the device signer's signature-expiration ledger on **mainnet** (L4). The extension never trusts the paired wallet's `rpcUrl` for this. Testnet uses SDF's pinned public endpoint automatically; mainnet has no universal public RPC, so this must be set — **mainnet signing fails closed if it is unset** rather than trusting the caller-supplied endpoint.

## Input Sanitization (#312)

dApp-provided connection payloads (such as dApp names, origins, descriptions, and icon URLs) are sanitized before being processed or rendered in the popup UI:
- **HTML & Script Escaping**: HTML special characters (`<`, `>`, `&`, `"`, `'`, `/`) are escaped using `escapeHtml()`.
- **Tag Stripping**: All HTML tags (`<script>`, `<iframe>`, etc.) are stripped using `sanitizeString()`.
- **URL Protocol Filtering**: Dangerous URI schemes (`javascript:`, `data:`, `vbscript:`) are filtered out by `sanitizeUrl()`.
- **Control Character Scrubbing**: Control characters are stripped to prevent display spoofing.
- **Length Truncation**: Strings are bounded by maximum length ceilings (e.g. 100 chars for names, 500 chars for descriptions).

## Error Reporting Integration (#302)

Uncaught exceptions, background worker rejections, and signing failures are automatically captured and forwarded to the centralized error reporting client via `backgroundErrorReporter`:
- **Context Metadata**: Every reported error automatically embeds `extensionVersion` (from `WXT_PUBLIC_VERSION`) and `browserInfo` (`navigator.userAgent` or worker environment tag).
- **Global Handlers**: Registered on background worker startup (`self.addEventListener('error')`, `self.addEventListener('unhandledrejection')`).
- **Resilience**: Error delivery failures fail safely to console without interrupting service worker routing or user transaction flows.


