import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from udm_report import export  # noqa: E402
from test_report import fixture  # noqa: E402


class ExportTest(unittest.TestCase):
    def test_writes_dashboard_files(self):
        with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as out:
            export.main(["--from-dir", str(fixture(src)), "--out", out, "--date", "2026-10-16"])
            sessions = json.loads((Path(out) / "sessions.json").read_text())
            meta = json.loads((Path(out) / "meta.json").read_text())
            self.assertEqual(meta["window_start"], "2026-09-01")
            self.assertEqual(meta["window_end"], "2026-10-15")
            self.assertEqual(len(sessions), 7)
            rev = next(r for r in sessions if r["session"] == "b")
            self.assertEqual((rev["revision"], rev["revision_type"], rev["week"]), (True, "Revision", "2026-W42"))
            self.assertTrue(next(r for r in sessions if r["session"] == "d")["runaway"])
            self.assertTrue(next(r for r in sessions if r["session"] == "g")["clockin"])
            self.assertEqual(set(sessions[0]), {
                "session", "project_id", "item_id", "date", "week", "week_label", "month", "month_label", "person",
                "team", "service_group", "service", "project", "task", "log_name", "hours", "runaway", "revision",
                "revision_type", "clockin", "clockin_type"})


if __name__ == "__main__":
    unittest.main()
