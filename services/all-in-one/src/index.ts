// Combined single-process backend for deployment (e.g. Railway).
//
// Boots the request-serving backend services in ONE Node process:
//   - wallet-service       on WALLET_SERVICE_PORT       (default 4001)
//   - lifecycle-service    on LIFECYCLE_SERVICE_PORT    (default 4002)
//   - policy-service       on POLICY_SERVICE_PORT       (default 4003)
//   - verification-service on VERIFICATION_SERVICE_PORT (default 4004)
//   - api-gateway          on PORT                      (the PUBLIC port — $PORT)
//
// The gateway is the only publicly-exposed service; it proxies to the others
// over localhost (they're co-located in this process). This keeps the codebase
// modular — each service is still its own module with its own tests — while
// collapsing the deployment to a single service + one Postgres.
//
// verification-service is safe to co-locate: it only accepts submissions and
// serves read APIs — it never runs a build. The BUILD worker (worker-service)
// is deliberately NOT started here: it executes untrusted, submitter-provided
// build inputs and MUST run in its own isolated process, never alongside the
// wallet/policy services that hold sponsor keys (technical-doc.md §8.4). Deploy
// worker-service separately, pointed at the same DATABASE_URL.
//
// NOTE: intended for demo / low-scale hosting.

// Each service module self-starts (top-level await in its index), and awaiting
// the import ensures its listen() has resolved. Start the three internal
// services BEFORE the gateway, so the gateway's proxy targets are live.
await import("@vela/wallet-service");
await import("@vela/lifecycle-service");
await import("@vela/policy-service");
await import("@vela/verification-service");
await import("@vela/api-gateway");

// eslint-disable-next-line no-console
console.log("[all-in-one] all backend services started in one process");

export {};
