"""Turn raw Rework data into the numbers the weekly report shows. Pure functions, no I/O."""

import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

MYT = timezone(timedelta(hours=8))
HOURS_PER_DAY = 8
RUNAWAY_HOURS = 12  # one timer session longer than this was left running; left out
DONE, CANCELLED = 10, -1

REVISION_RE = re.compile(r"\b(revis\w*|rev\s?\d+|amend\w*|re-?edit\w*|changes?)\b", re.I)
CLOCKIN_RE = re.compile(r"clock\s?-?in|clockify", re.I)
# Titles Rework writes itself when the person types nothing: "[CODE-12] Task" or "Task · 9 Oct, 03:25"
AUTO_TITLE_RE = re.compile(r"^(\[[A-Z0-9-]+\]\s*)?(?P<task>.*?)(\s·\s\d{1,2} \w{3}, \d{2}:\d{2})?$")


@dataclass
class Session:
    id: str
    user_id: int
    hours: float
    started: datetime
    title: str
    task: str
    service: str
    client: str
    project: str

    @property
    def day(self):
        return self.started.date()

    @property
    def is_revision(self):
        return bool(REVISION_RE.search(self.title) or REVISION_RE.search(self.task))

    @property
    def is_untitled(self):
        m = AUTO_TITLE_RE.match(self.title.strip())
        return not self.title.strip() or (m and m.group("task").strip().lower() == self.task.strip().lower())


@dataclass
class Task:
    id: str
    name: str
    client: str
    service: str
    status: int
    deadline: int
    finished_at: int


def load(source):
    """Pull every service once. Returns (sessions, tasks, client_names)."""
    groups = {g["id"]: g["name"] for g in source.groups()}
    sessions, tasks, seen = [], [], set()
    for svc in source.services():
        if svc.get("status") != 1:
            continue
        client = groups.get(svc.get("group_id"), "(no client)")
        res = source.resource_items(svc["id"])
        projects = {p["id"]: p.get("name", "") for p in res.get("projects", [])}
        for item in res.get("items", []):
            if item.get("metatype") != "workload":
                continue
            meta = (item.get("data") or {}).get("recorded_meta") or {}
            for s in meta.get("sessions", []):
                if s["id"] in seen:
                    continue
                seen.add(s["id"])
                sessions.append(Session(
                    id=s["id"], user_id=int(s.get("user_id") or 0), hours=s.get("seconds", 0) / 3600,
                    started=datetime.fromtimestamp(s["started_at"], MYT), title=s.get("name") or "",
                    task=item.get("name") or "", service=svc["name"], client=client,
                    project=projects.get(item.get("project_id"), ""),
                ))
        for it in source.work_items(svc["id"]).get("items", []):
            tasks.append(Task(
                id=it["id"], name=it.get("name", ""), client=client, service=svc["name"],
                status=it.get("status", 0), deadline=it.get("deadline") or 0,
                finished_at=it.get("finished_at") or 0,
            ))
    return sessions, tasks, sorted(set(groups.values()))


def working_days(start, end):
    """Mon–Fri days in [start, end)."""
    return sum(1 for i in range((end - start).days) if (start + timedelta(i)).weekday() < 5)


def _sum(sessions, key):
    out = defaultdict(float)
    for s in sessions:
        out[key(s)] += s.hours
    return dict(sorted(out.items(), key=lambda kv: -kv[1]))


def in_range(sessions, start, end):
    return [s for s in sessions if start <= s.day < end]


@dataclass
class Window:
    label: str
    start: date
    end: date  # exclusive


def windows(run_day):
    """The week is the 7 days before the run day (Fri–Thu); month-to-date runs to the day before."""
    week = Window("week", run_day - timedelta(7), run_day)
    prev = Window("prev", run_day - timedelta(14), run_day - timedelta(7))
    first = (run_day - timedelta(1)).replace(day=1)
    mtd = Window("mtd", first, run_day)
    return week, prev, mtd


def previous_month(run_day):
    """Full previous month, reported on the first Friday of a new month (run_day.day <= 7)."""
    if run_day.day > 7:
        return None
    end = run_day.replace(day=1)
    start = (end - timedelta(1)).replace(day=1)
    return Window("month", start, end)


def build(sessions, tasks, users, internal_groups, run_day, now_ts):
    """All numbers for one weekly report."""
    good = [s for s in sessions if s.hours <= RUNAWAY_HOURS]
    runaway = [s for s in sessions if s.hours > RUNAWAY_HOURS]
    week, prev, mtd = windows(run_day)
    wk, pv, md = in_range(good, week.start, week.end), in_range(good, prev.start, prev.end), in_range(good, mtd.start, mtd.end)

    team_of = lambda s: users.get(str(s.user_id), {}).get("team", "Other")
    name_of = lambda uid: users.get(str(uid), {}).get("name", f"user {uid}")
    client_work = lambda ss: [s for s in ss if s.client not in internal_groups]

    mtd_client = _sum(client_work(md), lambda s: s.client)
    week_client = _sum(client_work(wk), lambda s: s.client)
    mtd_scope = defaultdict(dict)
    for (client, service), h in _sum(client_work(md), lambda s: (s.client, s.service)).items():
        mtd_scope[client][service] = h

    logged_ids = {s.user_id for s in wk}
    wk_start_ts = datetime.combine(week.start, datetime.min.time(), MYT).timestamp()
    wk_end_ts = datetime.combine(week.end, datetime.min.time(), MYT).timestamp()
    live = [t for t in tasks if t.status != CANCELLED]
    overdue = [t for t in live if t.status != DONE and 0 < t.deadline < now_ts]
    revs = [s for s in wk if s.is_revision]
    rev_tasks = defaultdict(int)
    for s in revs:
        rev_tasks[(s.client, s.task)] += 1

    return {
        "week": week, "prev": prev, "mtd": mtd,
        "clients": {
            "mtd": mtd_client, "week": week_client, "scope": {c: dict(sorted(v.items(), key=lambda kv: -kv[1])) for c, v in mtd_scope.items()},
        },
        "team": {
            "hours": sum(s.hours for s in wk), "prev_hours": sum(s.hours for s in pv),
            "people_logged": len(logged_ids & {int(u) for u in users}), "people_total": len(users),
            "benchmark": working_days(week.start, week.end) * HOURS_PER_DAY,
            "by_team": _sum(wk, team_of),
            "by_person": {name_of(k): v for k, v in _sum(wk, lambda s: s.user_id).items()},
            "not_logged": sorted(name_of(u) for u in users if int(u) not in logged_ids),
        },
        "delivery": {
            "done_week": sum(1 for t in live if t.status == DONE and wk_start_ts <= t.finished_at < wk_end_ts),
            "done": sum(1 for t in live if t.status == DONE), "total": len(live), "overdue": len(overdue),
            "overdue_by_client": _count(overdue, lambda t: t.client),
        },
        "revisions": {
            "logs": len(revs), "tasks": len(rev_tasks), "hours": sum(s.hours for s in revs),
            "top": sorted(rev_tasks.items(), key=lambda kv: -kv[1])[:3],
        },
        "internal_hours": sum(s.hours for s in wk if s.client in internal_groups or CLOCKIN_RE.search(s.task)),
        "hygiene": {
            "untitled": sum(1 for s in wk if s.is_untitled), "logs": len(wk),
            "runaway": len([s for s in runaway if week.start <= s.day < week.end]),
            "runaway_hours": sum(s.hours for s in runaway if week.start <= s.day < week.end),
        },
    }


def build_month(sessions, internal_groups, month):
    """Hours per client and scope for one full month (retainer check)."""
    good = [s for s in in_range(sessions, month.start, month.end) if s.hours <= RUNAWAY_HOURS]
    client_work = [s for s in good if s.client not in internal_groups]
    scope = defaultdict(dict)
    for (client, service), h in _sum(client_work, lambda s: (s.client, s.service)).items():
        scope[client][service] = h
    return {
        "month": month, "total": sum(s.hours for s in good),
        "clients": _sum(client_work, lambda s: s.client),
        "scope": {c: dict(sorted(v.items(), key=lambda kv: -kv[1])) for c, v in scope.items()},
        "internal": sum(s.hours for s in good if s.client in internal_groups),
    }


def _count(items, key):
    out = defaultdict(int)
    for i in items:
        out[key(i)] += 1
    return dict(sorted(out.items(), key=lambda kv: -kv[1]))
