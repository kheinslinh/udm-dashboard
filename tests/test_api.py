import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from udm_report import source  # noqa: E402


class FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class ApiSourceTest(unittest.TestCase):
    def test_public_api_v1_requests(self):
        calls = []
        pages = {
            "/v1/project/list": [{"status": 1, "projects": [{"id": "p1", "name": "Oct"}], "has_more": False}],
            "/v1/task/list": [{"status": 1, "tasks": [{"id": "t1"}], "has_more": True},
                              {"status": 1, "tasks": [{"id": "t2"}], "has_more": False}],
        }

        def fake_urlopen(req, timeout):
            path = req.full_url.replace("https://api.test/project", "")
            calls.append((req.get_method(), path, dict(req.header_items()), json.loads(req.data)))
            return FakeResp(json.dumps(pages[path].pop(0)).encode())

        api = source.ApiSource("https://api.test/project/", "tok", config={"api_user_id": 6144,
                                                                          "group_names": {"g1": "GIANT"}})
        api.MIN_INTERVAL = 0
        with mock.patch.object(source.urllib.request, "urlopen", fake_urlopen):
            work = api.work_items("s1")
        self.assertEqual([t["id"] for t in work["items"]], ["t1", "t2"])
        self.assertEqual(work["projects"], [{"id": "p1", "name": "Oct"}])
        method, path, headers, body = calls[0]
        self.assertEqual((method, path), ("POST", "/v1/project/list"))
        self.assertEqual(headers["X-api-token"], "tok")
        self.assertEqual(body, {"user_id": 6144, "limit": 200, "page": 0, "service_id": "s1"})
        self.assertEqual([c[3]["page"] for c in calls[1:]], [0, 1])
        self.assertEqual(api.groups(), [{"id": "g1", "name": "GIANT"}])
        self.assertEqual(api.resource_items("s1"), {})  # no time-log endpoint configured yet


if __name__ == "__main__":
    unittest.main()
