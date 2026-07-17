// Combined single-process backend for deployment (e.g. Railway).
//
// Boots all four backend services in ONE Node process:
//   - wallet-service    on WALLET_SERVICE_PORT    (default 4001)
//   - lifecycle-service on LIFECYCLE_SERVICE_PORT (default 4002)
//   - policy-service    on POLICY_SERVICE_PORT    (default 4003)
//   - api-gateway       on PORT                   (the PUBLIC port — Railway sets $PORT)
//
// The gateway is the only publicly-exposed service; it proxies to the other
// three over localhost (they're co-located in this process). This keeps the
// codebase modular — each service is still its own module with its own tests —
// while collapsing the deployment to a single service + one Postgres.
//
// NOTE: intended for demo / low-scale hosting. Once worker-service (untrusted
// deterministic build containers) ships, that must run in its OWN isolated
// process — never combined with the wallet service that holds sponsor keys.

// Each service module self-starts (top-level await in its index), and awaiting
// the import ensures its listen() has resolved. Start the three internal
// services BEFORE the gateway, so the gateway's proxy targets are live.
await import("@vela/wallet-service");
await import("@vela/lifecycle-service");
await import("@vela/policy-service");
await import("@vela/api-gateway");

// eslint-disable-next-line no-console
console.log("[all-in-one] all backend services started in one process");

export {};
