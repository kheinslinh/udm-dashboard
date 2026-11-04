"""python -m udm_report.export [--from-dir DIR] [--out site/data] [--date YYYY-MM-DD]

Writes the dashboard's data files (sessions, projects, people, meta) from Rework,
covering the first day of last month up to the day before the run.
"""

import argparse
import functools
import json
import re
import time
from datetime import date, datetime, timedelta
from pathlib import Path

from . import compute
from .source import ApiSource, DirSource

CONFIG = json.loads((Path(__file__).parent / "teams.json").read_text())


def week_fields(day):
    year, week, _ = day.isocalendar()
    mon = day - timedelta(day.weekday())
    sun = mon + timedelta(6)
    rng = f"{mon.day}–{sun.day} {sun:%b}" if mon.month == sun.month else f"{mon.day} {mon:%b}–{sun.day} {sun:%b}"
    return f"{year}-W{week:02d}", f"W{week} · {rng}"


def revision_type(s):
    m = compute.REVISION_RE.search(s.title) or compute.REVISION_RE.search(s.task)
    return m.group(1).capitalize() if m else ""


def clockin_type(s):
    if re.search(r"clockify", s.task, re.I):
        return "Clockify catch-all"
    return "Clock-in task" if compute.CLOCKIN_RE.search(s.task) else ""


def session_rows(sessions, users, start, end):
    rows = []
    for s in sorted(sessions, key=lambda s: s.started):
        if not start <= s.day < end:
            continue
        user = users.get(str(s.user_id), {})
        week, week_label = week_fields(s.day)
        rows.append({
            "session": s.id, "project_id": s.project_id, "item_id": s.item_id,
            "date": s.day.isoformat(), "week": week, "week_label": week_label,
            "month": f"{s.day:%Y-%m}", "month_label": f"{s.day:%b %Y}",
            "person": user.get("name", f"user {s.user_id}"), "team": user.get("team", "Other"),
            "service_group": s.client, "service": s.service, "project": s.project, "task": s.task,
            "log_name": s.title, "hours": round(s.hours, 2), "runaway": s.hours > compute.RUNAWAY_HOURS,
            "revision": s.is_revision, "revision_type": revision_type(s) if s.is_revision else "",
            "clockin": bool(clockin_type(s)), "clockin_type": clockin_type(s),
        })
    return rows


def project_rows(tasks, now_ts, today):
    """Done / total / overdue per project, counted from its tasks (cancelled ones left out)."""
    by = {}
    for t in tasks:
        if t.status == compute.CANCELLED or not t.project_id:
            continue
        r = by.setdefault(t.project_id, {
            "project_id": t.project_id, "project": t.project, "service_group": t.client, "service": t.service,
            "done": 0, "total": 0, "overdue": 0})
        r["total"] += 1
        if t.status == compute.DONE:
            r["done"] += 1
        elif 0 < t.deadline < now_ts:
            r["overdue"] += 1
    return [{**r, "status": "Completed" if r["done"] >= r["total"] else "Active", "updated": today.isoformat()}
            for r in by.values()]


def _day(ts):
    return datetime.fromtimestamp(ts, compute.MYT).date().isoformat() if ts and ts > 0 else ""


def task_state(status, deadline, now_ts):
    if status == compute.DONE:
        return "done"
    if status == compute.CANCELLED or status == -10:
        return "cancelled"
    return "overdue" if 0 < deadline < now_ts else "open"


def detail_rows(source, users, now_ts, today):
    """tasks.json and projects.json: one row per task and per project, hours not money."""
    groups = {g["id"]: g["name"] for g in source.groups()}
    name = lambda uid: users.get(str(uid), {}).get("name", f"user {uid}") if uid else ""
    team = lambda uid: users.get(str(uid), {}).get("team", "Other") if uid else ""
    tasks, projects = [], []
    for svc in source.services():
        if svc.get("status") != 1:
            continue
        client = groups.get(svc.get("group_id"), "(no client)")
        work = source.work_items(svc["id"])
        if not work.get("items") and not work.get("projects"):
            continue
        stages = {st.get("id"): st.get("name", "") for st in source.stages(svc["id"])}
        types = {t.get("id"): t.get("name", "") for t in source.item_types(svc["id"])}
        counts = {}
        pnames = {p["id"]: p.get("name", "") for p in work.get("projects", [])}
        for it in work.get("items", []):
            state = task_state(it.get("status", 0), it.get("deadline") or 0, now_ts)
            pid = it.get("project_id") or ""
            c = counts.setdefault(pid, {"done": 0, "total": 0, "overdue": 0, "open_est": 0.0})
            if state != "cancelled":
                c["total"] += 1
                c["done"] += state == "done"
                c["overdue"] += state == "overdue"
            tasks.append({
                "id": it["id"], "name": it.get("name", ""), "project_id": pid, "project": pnames.get(pid, ""),
                "client": client, "service": svc["name"], "status": it.get("status", 0), "state": state,
                "stage": stages.get(it.get("stage_id"), ""), "item_type": types.get(it.get("item_type_id"), ""),
                "assignee": name(it.get("assignee_id")), "team": team(it.get("assignee_id")),
                "start": _day(it.get("start_date")), "deadline": _day(it.get("deadline")),
                "finished": _day(it.get("finished_at")), "created": _day(it.get("created_at")),
                "workload": it.get("workload") or 0, "priority": it.get("priority") or 0,
                "parent": bool(it.get("parent_id")), "url": it.get("url", ""),
            })
        for p in work.get("projects", []):
            c = counts.get(p["id"], {"done": 0, "total": 0, "overdue": 0})
            projects.append({
                "project_id": p["id"], "project": p.get("name", ""), "service_group": client, "service": svc["name"],
                "status_code": p.get("status"), "priority": p.get("priority") or 0,
                "owners": [name(u) for u in p.get("owners") or [] if isinstance(u, int)],
                "start": _day(p.get("start_date")), "deadline": _day(p.get("deadline")),
                "est_hours": round(float(p.get("effort") or 0), 2), "logged_hours": round(float(p.get("effort_recorded") or 0), 2),
                "done": c["done"], "total": c["total"], "overdue": c["overdue"],
                "status": "Completed" if c["total"] and c["done"] >= c["total"] else "Active",
                "updated": today.isoformat(), "url": p.get("url", ""),
            })
    return tasks, projects


class Cached:
    """Each service is fetched once even though sessions and projects both read it."""

    def __init__(self, source):
        self.source = source
        self.services = functools.cache(source.services)
        self.groups = functools.cache(source.groups)
        self.resource_items = functools.cache(source.resource_items)
        self.work_items = functools.cache(source.work_items)
        self.stages = functools.cache(source.stages)
        self.item_types = functools.cache(source.item_types)


def main(argv=None):
    p = argparse.ArgumentParser(prog="udm_report.export")
    p.add_argument("--from-dir")
    p.add_argument("--out", default="site/data")
    p.add_argument("--date", help="run day (default: today in Malaysia time)")
    args = p.parse_args(argv)

    today = date.fromisoformat(args.date) if args.date else datetime.now(compute.MYT).date()
    end = today  # exclusive: data runs to yesterday
    start = (today.replace(day=1) - timedelta(1)).replace(day=1)
    source = Cached(DirSource(args.from_dir) if args.from_dir else ApiSource(config=CONFIG))
    sessions, tasks, _ = compute.load(source)
    users = CONFIG["users"]
    last = end - timedelta(1)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    files = {
        "sessions": session_rows(sessions, users, start, end),
        "projects": None,
        "people": [{"person": u["name"], "team": u["team"], "title": u.get("title", u["team"])} for u in users.values()],
        "meta": {
            "window_start": start.isoformat(), "window_end": last.isoformat(), "last_day_share": 1,
            "note": (f"Hours are Rework timer sessions logged on tasks, {start.day} {start:%b} – {last.day} {last:%b %Y} "
                     f"(updated {datetime.now(compute.MYT):%d %b %Y, %H:%M} MYT). Benchmark: 8h per working day per person. "
                     "Timers left running over 12h are left out unless ticked below."),
        },
    }
    files["tasks"], files["projects"] = detail_rows(source, users, time.time(), today)
    if not sessions:
        # No time-log endpoint yet: keep the last hours snapshot instead of blanking the dashboard.
        for name in ("sessions", "meta"):
            files.pop(name)
    files["sync"] = {
        "updated_at": datetime.now(compute.MYT).astimezone().isoformat(timespec="seconds"),
        "hours_source": "rework" if sessions else "snapshot",
        "tasks": len(files["tasks"]), "projects": len(files["projects"]),
    }
    for name, data in files.items():
        (out / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, indent=0 if name == "meta" else None))
    print(f"wrote {len(files.get('sessions', []))} sessions, {len(files['projects'])} projects to {out}")


if __name__ == "__main__":
    main()
