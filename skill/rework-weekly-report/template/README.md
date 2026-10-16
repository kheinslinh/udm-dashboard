# Weekly Rework report + dashboard

- `python -m rework_report` builds the weekly report and posts it to Discord (`--dry-run` prints it).
- `python -m rework_report.export` writes `site/data/*.json` for the dashboard.
- `.github/workflows/weekly-report.yml` runs the report on Fridays; `refresh-dashboard.yml` refreshes the data daily.
- `site/` is the dashboard; deploy it with Vercel (`vercel.json`) or Netlify (`netlify.toml`).

Secrets: `REWORK_API_BASE`, `REWORK_API_TOKEN`, `DISCORD_WEBHOOK_URL`. Variable: `DASHBOARD_URL`.
Per-client settings: `rework_report/config.json`. Tests: `python -m unittest discover -s tests`.
