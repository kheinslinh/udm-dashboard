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

    REWORK_API_BASE    optional; defaults to https://api-v3.rework.com/project (with or without
                       "/project" or "/project/v1" on the end, it is read the same way)
    REWORK_API_TOKEN   Settings app -> APIs -> API keys, app "project": the "Secret" field (sent as X-API-TOKEN)
    REWORK_API_KEY     optional, same screen: the "API key" field (sent as Authorization: Bearer)
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
        token = token or os.environ.get("REWORK_API_TOKEN", "")
        self.api_key = os.environ.get("REWORK_API_KEY", "").strip()
        if not token and not self.api_key:
            raise SystemExit("Missing REWORK_API_TOKEN: add it under the repository's Actions secrets.")
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
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.token:
            headers["X-API-TOKEN"] = self.token
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
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

    def _try(self, headers):
        """One bare POST to /v1/ping; returns the HTTP status (no retry, no secrets in the result)."""
        data = json.dumps({"user_id": self.user_id}).encode()
        req = urllib.request.Request(self.base + "/v1/ping", data=data, method="POST",
                                     headers={"Content-Type": "application/json", **headers})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.status
        except urllib.error.HTTPError as e:
            return e.code

    def ping(self):
        """Find which header carries the key, then list the services the acting user can see."""
        tried = []
        for label, value, header in (("Secret in X-API-TOKEN", self.token, "x"),
                                     ("API key in Authorization: Bearer", self.api_key, "b"),
                                     ("API key in X-API-TOKEN", self.api_key, "x"),
                                     ("Secret in Authorization: Bearer", self.token, "b")):
            if not value:
                continue
            headers = {"X-API-TOKEN": value} if header == "x" else {"Authorization": f"Bearer {value}"}
            code = self._try(headers)
            tried.append(f"  {label}: HTTP {code}")
            if code == 200:
                self.token, self.api_key = (value, "") if header == "x" else ("", value)
                names = [s.get("name", s.get("id")) for s in self.services()]
                return "\n".join(tried + [f"Rework API OK with {label}: {len(names)} project services visible "
                                          f"({', '.join(names[:5])}{'…' if len(names) > 5 else ''})"])
            time.sleep(self.MIN_INTERVAL)
        raise SystemExit("No header combination was accepted:\n" + "\n".join(tried))

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
