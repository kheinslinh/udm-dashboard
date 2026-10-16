"""Where the raw Rework Project (v3) data comes from.

The report needs four things from Rework, one call per service for the last two:
  services        every project-app service (each belongs to a client "group")
  groups          the service groups, i.e. the clients
  resource_items  a service's workload records; each holds the timer sessions logged on a task
  work_items      a service's tasks (status, deadline, finished_at) for deliverables

Two sources return the same JSON shapes:
  DirSource  reads a folder of saved responses (tests, offline runs)
  ApiSource  calls the Rework Projects Public API (v1) over HTTPS
"""

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path


class DirSource:
    """Saved responses: services.json, groups.json, resource_items/<id>.json, work_items/<id>.json."""

    def __init__(self, root):
        self.root = Path(root)

    def _load(self, *parts):
        path = self.root.joinpath(*parts)
        return json.loads(path.read_text()) if path.exists() else {}

    def services(self):
        return self._load("services.json").get("services", [])

    def groups(self):
        return self._load("groups.json").get("groups", [])

    def resource_items(self, service_id):
        return self._load("resource_items", f"{service_id}.json")

    def work_items(self, service_id):
        return self._load("work_items", f"{service_id}.json")


class ApiSource:
    """Rework Projects Public API (v1): every call is a POST with a JSON body, the token goes in
    X-API-TOKEN and every call names an acting user (user_id) whose access narrows what comes back.

    REWORK_API_BASE    https://api-v3.rework.com/project
    REWORK_API_TOKEN   Settings app -> Apis -> API keys, app "project"
    REWORK_USER_ID     acting user; defaults to "api_user_id" in teams.json. Pick someone who can
                       see every service (a project manager), or services they can't see are skipped.
    REWORK_PATH_RESOURCE_ITEMS  endpoint for a service's timer sessions. Public API v1 has none yet;
                       until it is set, the report has no hours (tasks and deliverables still work).

    Client names: v1 returns a service's group_id but no group names, so they come from
    "group_names" in teams.json.
    """

    MIN_INTERVAL = 3.1  # seconds between calls: the token allows 200 requests / 10 minutes

    def __init__(self, base=None, token=None, user_id=None, config=None):
        base = base or os.environ.get("REWORK_API_BASE", "")
        token = token or os.environ.get("REWORK_API_TOKEN", "")
        missing = [n for n, v in (("REWORK_API_BASE", base), ("REWORK_API_TOKEN", token)) if not v]
        if missing:
            raise SystemExit(f"Missing {', '.join(missing)}: add it under the repository's Actions secrets.")
        self.base = base.rstrip("/")
        self.token = token
        self.config = config or {}
        self.user_id = int(user_id or os.environ.get("REWORK_USER_ID") or self.config.get("api_user_id") or 0)
        if not self.user_id:
            raise SystemExit("No acting user: set REWORK_USER_ID or api_user_id in teams.json.")
        self.sessions_path = os.environ.get("REWORK_PATH_RESOURCE_ITEMS") or ""
        self._last = 0.0

    def _post(self, path, **body):
        wait = self.MIN_INTERVAL - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()
        data = json.dumps({"user_id": self.user_id, **body}).encode()
        req = urllib.request.Request(self.base + path, data=data, method="POST", headers={
            "X-API-TOKEN": self.token, "Content-Type": "application/json", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                out = json.load(resp)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(int(e.headers.get("Retry-After") or 60))
                return self._post(path, **body)
            raise SystemExit(f"Rework API {e.code} on {path}: {e.read()[:500].decode('utf-8', 'replace')}")
        if out.get("status") != 1:
            raise SystemExit(f"Rework API error on {path}: {json.dumps(out)[:500]}")
        return out

    def _pages(self, path, key, **body):
        page = 0
        while True:
            out = self._post(path, limit=200, page=page, **body)
            yield from out.get(key, [])
            if not out.get("has_more"):
                return
            page += 1

    def services(self):
        return [s for s in self._pages("/v1/service/all", "services") if s.get("model", "project.project") == "project.project"]

    def groups(self):
        return [{"id": k, "name": v} for k, v in self.config.get("group_names", {}).items()]

    def resource_items(self, service_id):
        if not self.sessions_path:
            return {}
        return self._post(self.sessions_path.format(service_id=service_id), service_id=service_id)

    def work_items(self, service_id):
        projects, items = [], []
        for p in self._pages("/v1/project/list", "projects", service_id=service_id):
            projects.append({"id": p["id"], "name": p.get("name", "")})
            items += self._pages("/v1/task/list", "tasks", project_id=p["id"], include_archived=0)
        return {"projects": projects, "items": items}
