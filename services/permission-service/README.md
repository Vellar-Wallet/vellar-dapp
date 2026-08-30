# @vellar/permission-service

dApp origin permissions, extension connection records, revocation state

## Configuration

`PERMISSION_CACHE_TTL_MS` controls how long origin permissions remain in the
in-memory cache. It defaults to `300000` (5 minutes). Values must be between
`1000` (1 second) and `86400000` (24 hours), inclusive; invalid values use the
default.
