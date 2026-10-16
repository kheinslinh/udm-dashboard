"""python -m udm_report [--date YYYY-MM-DD] [--from-dir DIR] [--dry-run]

Builds the UDM weekly report from Rework and posts it to Discord (DISCORD_WEBHOOK_URL).
On the first Friday of a month it also posts last month's client-hours summary.
"""

import argparse
import json
import os
import sys
import time
from datetime import date, datetime
from pathlib import Path

from . import compute, render
from .source import ApiSource, DirSource

CONFIG = json.loads((Path(__file__).parent / "teams.json").read_text())


def main(argv=None):
    p = argparse.ArgumentParser(prog="udm_report")
    p.add_argument("--date", help="run day (default: today in Malaysia time)")
    p.add_argument("--from-dir", help="read saved Rework responses instead of calling the API")
    p.add_argument("--dry-run", action="store_true", help="print instead of posting to Discord")
    args = p.parse_args(argv)

    run_day = date.fromisoformat(args.date) if args.date else datetime.now(compute.MYT).date()
    source = DirSource(args.from_dir) if args.from_dir else ApiSource(config=CONFIG)
    sessions, tasks, _ = compute.load(source)
    users, internal = CONFIG["users"], set(CONFIG["internal_groups"])

    messages = [render.weekly(compute.build(sessions, tasks, users, internal, run_day, time.time()),
                              os.environ.get("DASHBOARD_URL"))]
    month = compute.previous_month(run_day)
    if month and sessions:
        messages.append(render.monthly(compute.build_month(sessions, internal, month)))

    if args.dry_run:
        print("\n\n---\n\n".join(messages))
        return 0
    webhook = os.environ.get("DISCORD_WEBHOOK_URL")
    if not webhook:
        print("DISCORD_WEBHOOK_URL is not set", file=sys.stderr)
        return 1
    for m in messages:
        render.post(webhook, m)
    return 0


if __name__ == "__main__":
    sys.exit(main())
