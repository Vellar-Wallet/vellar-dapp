# Infra

Deployment and infrastructure config. See technical-doc.md §6.4 and idea.md §14.

- `docker/` — Dockerfiles and compose for local dev (Postgres, Redis) and isolated deterministic build workers for verification.
- `monitoring/` — Prometheus alert rules, Alertmanager routing, Grafana dashboards and a compose file that runs them (see docs/observability.md).
- `k8s/` — manifests for backend services when we reach staging/production.

Environments: local → dev → staging → production.
