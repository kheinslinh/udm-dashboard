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

    def stages(self, service_id):
        return self._load("stages", f"{service_id}.json").get("stages", [])

    def item_types(self, service_id):
        return self._load("item_types", f"{service_id}.json").get("itemtypes", [])


class ApiSource:
    """Rework Projects Public API (v1): every call is a POST with a JSON body, the token goes in
    X-API-TOKEN and every call names an acting user (user_id) whose access narrows what comes back.

    REWORK_API_BASE    optional; defaults to https://api-v3.rework.com/project (with or without
                       "/project" or "/project/v1" on the end, it is read the same way)
    REWORK_API_KEY       Settings app -> APIs -> API keys, app "project": the "API key" field (X-API-TOKEN)
    REWORK_API_PASSWORD  same screen: the "Password" field (X-API-PASSWORD)
    (REWORK_API_TOKEN is read as a fallback for REWORK_API_KEY.)
    REWORK_USER_ID     acting user; defaults to "api_user_id" in teams.json. Pick someone who can
                       see every service (a project manager), or services they can't see are skipped.
    REWORK_PATH_RESOURCE_ITEMS  endpoint for a service's timer sessions. Public API v1 has none yet;
                       until it is set, the report has no hours (tasks and deliverables still work).

    Client names: v1 returns a service's group_id but no group names, so they come from
    "group_names" in teams.json.
    """

    DEFAULT_BASE = "https://api-v3.rework.com/project"
    MIN_INTERVAL = 3.1  # seconds between calls: the token allows 200 requests / 10 minutes

    @staticmethod
    def normalise_base(base):
        """Accept the host alone, host/project or host/project/v1; calls add /v1/... themselves."""
        base = base.strip().rstrip("/")
        if base.endswith("/v1"):
            base = base[:-3]
        if not base.endswith("/project"):
            base += "/project"
        return base

    def __init__(self, base=None, token=None, user_id=None, config=None):
        base = base or os.environ.get("REWORK_API_BASE", "") or self.DEFAULT_BASE
        token = token or os.environ.get("REWORK_API_KEY", "") or os.environ.get("REWORK_API_TOKEN", "")
        self.password = os.environ.get("REWORK_API_PASSWORD", "").strip()
        if not token:
            raise SystemExit("Missing REWORK_API_KEY: add it under the repository's Actions secrets.")
        self.base = self.normalise_base(base)
        self.token = token.strip()
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
        headers = {"Content-Type": "application/json", "Accept": "application/json", "X-API-TOKEN": self.token}
        if self.password:
            headers["X-API-PASSWORD"] = self.password
        req = urllib.request.Request(self.base + path, data=data, method="POST", headers=headers)
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

    def ping(self):
        """Check the key and acting user: /v1/ping, then the services the user can see."""
        self._post("/v1/ping")
        services = list(self._pages("/v1/service/all", "services"))
        names = [s.get("name", s.get("id")) for s in services]
        lines = [f"Rework API OK at {self.base}: {len(names)} services visible "
                 f"({', '.join(names[:5])}{'…' if len(names) > 5 else ''})"]
        lines += self._field_sample(services)
        return "\n".join(lines)

    def _field_sample(self, services):
        """Field names (and value types) of one service, project and task, to plan dashboard widgets."""
        def shape(obj, depth=0):
            if isinstance(obj, dict) and depth < 2:
                return {k: shape(v, depth + 1) for k, v in obj.items()}
            if isinstance(obj, list):
                return [shape(obj[0], depth + 1)] if obj else []
            return type(obj).__name__ if not isinstance(obj, (int, float, bool)) or isinstance(obj, bool) else obj.__class__.__name__
        out = []
        svc = next((s for s in services if s.get("model", "project.project") == "project.project" and s.get("status") == 1), None)
        if not svc:
            return out
        out.append("service fields: " + json.dumps(shape(svc)))
        for p in self._pages("/v1/project/list", "projects", service_id=svc["id"]):
            out.append("project fields: " + json.dumps(shape(p)))
            for t in self._pages("/v1/task/list", "tasks", project_id=p["id"], include_archived=0):
                out.append("task fields: " + json.dumps(shape(t)))
                break
            break
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

    def _optional(self, path, key, **body):
        """A lookup the dashboard can live without: an error gives an empty list, not a failed sync."""
        try:
            out = self._post(path, **body)
        except SystemExit as e:
            print(f"skipped {path}: {e}")
            return []
        found = out.get(key)
        if found is None:  # response key not documented: take the first list in the reply
            found = next((v for v in out.values() if isinstance(v, list)), [])
        return found

    def stages(self, service_id):
        return self._optional("/v1/service/get.stages", "stages", service_id=service_id)

    def item_types(self, service_id):
        return self._optional("/v1/service/get.itemtypes", "itemtypes", service_id=service_id)

    def groups(self):
        return [{"id": k, "name": v} for k, v in self.config.get("group_names", {}).items()]

    def resource_items(self, service_id):
        if not self.sessions_path:
            return {}
        return self._post(self.sessions_path.format(service_id=service_id), service_id=service_id)

    def work_items(self, service_id):
        projects, items = [], []
        for p in self._pages("/v1/project/list", "projects", service_id=service_id):
            fin = p.get("financials") or {}
            # Money fields are left behind on purpose: the dashboard shows hours only.
            projects.append({"id": p["id"], "name": p.get("name", ""), "status": p.get("status"),
                             "priority": p.get("priority"), "owners": p.get("owners") or [],
                             "start_date": p.get("start_date") or 0, "deadline": p.get("deadline") or 0,
                             "created_at": p.get("created_at") or 0, "url": p.get("url", ""),
                             "effort": fin.get("effort") or 0, "effort_recorded": fin.get("effort_recorded") or 0})
            items += self._pages("/v1/task/list", "tasks", project_id=p["id"], include_archived=0)
        return {"projects": projects, "items": items}
