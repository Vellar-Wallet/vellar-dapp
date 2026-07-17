# @vela/service-kit

Shared backend service bootstrap: health route, startup, graceful shutdown. Extracted once the second real service existed (see docs/decisions.md) so every `services/*` server stays consistent without copy-paste.
