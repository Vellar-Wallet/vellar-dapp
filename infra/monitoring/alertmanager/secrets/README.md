# Alertmanager secrets

Create these files here (they are git-ignored) before starting the stack:

- `slack_webhook_url` — a Slack incoming-webhook URL, one line, no trailing text.
- `oncall_webhook_url` — the webhook for critical alerts (PagerDuty Events v2,
  Opsgenie, or any relay that accepts the Alertmanager webhook payload).

Alertmanager reads them via `api_url_file` / `url_file`, so no secret ever lands
in `alertmanager.yml`.
