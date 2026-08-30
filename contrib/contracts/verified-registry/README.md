# Verified Registry Contract

Soroban contract that maintains a registry of verified wasm hashes. Other contracts (e.g. the verified-only policy) query this registry during authorization to check whether a target contract's wasm has been independently verified.

## Functions

| Function | Auth | Description |
|---|---|---|
| `__constructor(admin: Address)` | — | Sets the single admin address. Called once at deploy. |
| `add(wasm_hash: BytesN<32>)` | admin | Marks a wasm hash as verified. Emits `add` event. |
| `remove(wasm_hash: BytesN<32>)` | admin | Removes a wasm hash. Emits `rmv` event. |
| `is_verified(wasm_hash: BytesN<32>) -> bool` | none | Returns `true` if the hash is currently verified, `false` otherwise. Never panics on unknown input — safe for authorization paths. |

## Storage

- **Instance**: `Admin` address (written once).
- **Persistent**: One entry per wasm hash keyed by `Verified(hash)`. Contains `VerifiedEntry { added_at: u64 }`. TTL extended on every write (~30 days).

## Design Notes

- `is_verified` is a cheap O(1) persistent read. It is designed to be called inside authorization paths where resource use is bounded.
- Returning `false` for an unknown hash is correct behaviour. The contract never panics on unknown input.
- Entries expire silently if not renewed. The contract does not enforce TTL — a stopped keeper means entries eventually expire.
