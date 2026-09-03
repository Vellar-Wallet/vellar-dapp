# Wallet Service Observability

This document covers the observability patterns, metrics, and recommended alerts for the wallet-service.

## Metrics

### Cache Hit/Miss Metrics

The wallet-service caches frequently accessed data (balances, nonces, account details, transaction history) and exposes hit/miss counters via Prometheus.

**Metric Names:**

- `wallet_service_cache_hits_total` — Counter for cache hits, labeled by `resource` (e.g., `balance`, `nonce`, `account`, `tx-history`)
- `wallet_service_cache_misses_total` — Counter for cache misses, labeled by resource

**Label Values (Low Cardinality):**

- `resource`: One of `balance`, `nonce`, `account`, `tx-history` (or `unknown` for unrecognized labels, which indicates a bug)

**Example Queries:**

```promql
# Hit rate for balance cache (last 5 minutes)
rate(wallet_service_cache_hits_total{resource="balance"}[5m])

# Miss rate for balance cache
rate(wallet_service_cache_misses_total{resource="balance"}[5m])

# Total cache hit ratio (all resources, via recording rule or on-the-fly)
sum(rate(wallet_service_cache_hits_total[5m])) / (sum(rate(wallet_service_cache_hits_total[5m])) + sum(rate(wallet_service_cache_misses_total[5m])))
```

### Recommended Prometheus Recording Rule

To avoid expensive on-the-fly calculations in Grafana, define a recording rule in your Prometheus configuration:

```yaml
- record: wallet:cache:hit_ratio
  expr: |
    sum by (resource) (rate(wallet_service_cache_hits_total[5m]))
    /
    (
      sum by (resource) (rate(wallet_service_cache_hits_total[5m]))
      +
      sum by (resource) (rate(wallet_service_cache_misses_total[5m]))
    )
```

Then query the pre-computed ratio:

```promql
wallet:cache:hit_ratio{resource="balance"}
```

## Security & Privacy

Cache metrics **do not** expose PII or high-cardinality identifiers:

- No wallet addresses or user IDs in labels
- No raw cache keys
- No request IDs or sensitive identifiers
- Resource labels are constrained to an allowlist (`balance`, `nonce`, `account`, `tx-history`) to prevent cardinality explosion

## Recommended Alerts

### Low Cache Hit Ratio (Potential Performance Issue)

```yaml
- alert: WalletServiceLowCacheHitRatio
  expr: wallet:cache:hit_ratio{resource="balance"} < 0.5
  for: 15m
  annotations:
    summary: "Low cache hit ratio for {{ $labels.resource }} ({{ $value | humanizePercentage }})"
    description: "Wallet-service cache hit ratio for {{ $labels.resource }} is below 50% for 15 minutes. Consider increasing cache TTL or cache size."
```

### High Cache Miss Rate

```yaml
- alert: WalletServiceHighCacheMissRate
  expr: rate(wallet_service_cache_misses_total[5m]) > 10  # Adjust threshold based on expected traffic
  for: 10m
  annotations:
    summary: "High cache miss rate for wallet-service {{ $labels.resource }}"
    description: "Cache miss rate for {{ $labels.resource }} is {{ $value | humanize }}/sec for 10 minutes. Possible cache invalidation or high load."
```

## Accessing Metrics

The metrics are exposed via the `/metrics` HTTP endpoint on the wallet-service port (default: `4001`):

```bash
curl http://localhost:4001/metrics | grep wallet_service_cache
```

## Dashboard Configuration

See `infra/monitoring/grafana/wallet-service-cache.json` for a pre-built Grafana dashboard panel showing cache hit/miss rates and derived ratios for each resource type.

## Testing

- **Unit tests**: `src/cache-metrics.test.ts` validates that metrics are incremented correctly on cache hits/misses
- **Integration tests**: `src/metrics-integration.test.ts` verifies metrics are exposed on the `/metrics` endpoint

## Implementation Details

The cache layer is instrumented by wrapping the underlying storage (`CacheOperation`) with `createCacheMetricsWrapper()` in `src/cache-metrics.ts`. This wrapper:

1. Increments `wallet_service_cache_hits_total` on every cache hit
2. Increments `wallet_service_cache_misses_total` on every cache miss
3. Normalizes resource labels and maps unknown resources to `unknown` to prevent cardinality explosion
4. Is non-blocking and best-effort — metric recording errors never interfere with cache operations

## Further Reading

- `src/cache-metrics.ts` — Metric definitions and wrapper implementation
- `src/cache.ts` — In-memory cache storage (replaceable with Redis, etc.)
- `packages/service-kit/src/metrics.ts` — Central Prometheus registry and HTTP metric registration
