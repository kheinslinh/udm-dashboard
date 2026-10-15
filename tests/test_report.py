import json
import sys
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from udm_report import compute, render  # noqa: E402
from udm_report.source import DirSource  # noqa: E402

RUN_DAY = date(2026, 10, 16)  # a Friday: week = 9–15 Oct, month-to-date = 1–15 Oct


def ts(day, hour=10):
    return int(datetime(2026, 10, day, hour, tzinfo=compute.MYT).timestamp())


def session(sid, user, hours, day, title):
    return {"id": sid, "user_id": user, "seconds": int(hours * 3600), "started_at": ts(day), "name": title}


def workload(task, project, sessions):
    return {"metatype": "workload", "name": task, "project_id": project,
            "data": {"recorded_meta": {"sessions": sessions}}}


USERS = {"1": {"name": "Ann", "team": "Creative"}, "2": {"name": "Bo", "team": "Performance"},
         "3": {"name": "Cy", "team": "Creative"}}


def fixture(root):
    root = Path(root)
    (root / "resource_items").mkdir()
    (root / "work_items").mkdir()
    (root / "services.json").write_text(json.dumps({"services": [
        {"id": "s1", "name": "Social", "group_id": "g1", "status": 1},
        {"id": "s2", "name": "Performance", "group_id": "g1", "status": 1},
        {"id": "s3", "name": "Clock in", "group_id": "g2", "status": 1},
    ]}))
    (root / "groups.json").write_text(json.dumps({"groups": [
        {"id": "g1", "name": "GCH-GIANT"}, {"id": "g2", "name": "CLOCK IN"}]}))
    (root / "resource_items" / "s1.json").write_text(json.dumps({"projects": [{"id": "p1", "name": "Giant Oct"}], "items": [
        workload("Leaflet A", "p1", [
            session("a", 1, 3, 10, "[GIA-1] Leaflet A"),          # this week, untitled
            session("b", 1, 2, 12, "Revision 1 from client"),     # this week, revision
            session("c", 3, 1, 5, "Leaflet A · 5 Oct, 10:00"),    # earlier in month, untitled
            session("d", 3, 20, 13, "forgot to stop"),            # runaway, left out
        ]),
    ]}))
    (root / "resource_items" / "s2.json").write_text(json.dumps({"items": [
        workload("Ads setup", "p2", [session("e", 2, 4, 14, "Campaign build"),
                                     session("f", 2, 5, 3, "Old week work")]),  # previous week
    ]}))
    (root / "resource_items" / "s3.json").write_text(json.dumps({"items": [
        workload("Clock in", "p3", [session("g", 3, 1.5, 9, "Clock in")]),
    ]}))
    (root / "work_items" / "s1.json").write_text(json.dumps({"items": [
        {"id": "t1", "name": "Leaflet A", "status": 10, "deadline": ts(20), "finished_at": ts(11)},
        {"id": "t2", "name": "Leaflet B", "status": 1, "deadline": ts(8), "finished_at": 0},
        {"id": "t3", "name": "Old", "status": -1, "deadline": ts(1), "finished_at": 0},
    ]}))
    return root


class ReportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.sessions, self.tasks, _ = compute.load(DirSource(fixture(self.tmp.name)))
        self.r = compute.build(self.sessions, self.tasks, USERS, {"CLOCK IN"}, RUN_DAY, ts(16, 9))

    def tearDown(self):
        self.tmp.cleanup()

    def test_client_hours_month_to_date_and_week(self):
        c = self.r["clients"]
        self.assertAlmostEqual(c["mtd"]["GCH-GIANT"], 3 + 2 + 1 + 4 + 5)
        self.assertAlmostEqual(c["week"]["GCH-GIANT"], 3 + 2 + 4)
        self.assertNotIn("CLOCK IN", c["mtd"])
        self.assertEqual(list(c["scope"]["GCH-GIANT"]), ["Performance", "Social"])

    def test_team_and_benchmark(self):
        t = self.r["team"]
        self.assertAlmostEqual(t["hours"], 3 + 2 + 4 + 1.5)
        self.assertAlmostEqual(t["prev_hours"], 5 + 1)
        self.assertEqual(t["benchmark"], 5 * 8)
        self.assertEqual(t["people_logged"], 3)
        self.assertEqual(t["not_logged"], [])

    def test_delivery_revisions_hygiene(self):
        self.assertEqual(self.r["delivery"], {"done_week": 1, "done": 1, "total": 2, "overdue": 1,
                                              "overdue_by_client": {"GCH-GIANT": 1}})
        self.assertEqual(self.r["revisions"]["logs"], 1)
        self.assertEqual(self.r["hygiene"]["untitled"], 2)  # "[GIA-1] Leaflet A" and "Clock in"
        self.assertEqual(self.r["hygiene"]["runaway"], 1)
        self.assertAlmostEqual(self.r["internal_hours"], 1.5)

    def test_monthly_only_on_first_friday(self):
        self.assertIsNone(compute.previous_month(RUN_DAY))
        m = compute.previous_month(date(2026, 11, 6))
        self.assertEqual((m.start, m.end), (date(2026, 10, 1), date(2026, 11, 1)))
        summary = compute.build_month(self.sessions, {"CLOCK IN"}, m)
        self.assertAlmostEqual(summary["clients"]["GCH-GIANT"], 15)

    def test_render_fits_discord(self):
        text = render.weekly(self.r, "https://example.com/dash")
        self.assertIn("Week 42", text)
        self.assertIn("GCH-GIANT — **15.0h** (+9.0h this week)", text)
        self.assertTrue(all(len(p) <= render.DISCORD_LIMIT for p in render.chunks(text * 3)))


if __name__ == "__main__":
    unittest.main()
