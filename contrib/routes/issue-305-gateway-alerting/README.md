# Issue 305 — API Gateway 5xx Elevated Rate Alerting

This module implements alert evaluation logic and on-call notification routing for elevated 5xx error rates on `api-gateway`.

## Alert Rule Specification
- **Metric**: `http_requests_total{service="api-gateway", status=~"5.."}` / `http_requests_total{service="api-gateway"}`
- **Threshold**: > 5.0% error rate over a 60-second rolling window
- **Routing**: Sent to `#on-call-incidents` via webhook payload
- **Runbook**: `https://docs.vellar.internal/runbooks/api-gateway-5xx-elevated-rate`
