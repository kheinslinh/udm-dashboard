"""Where the raw Rework Project (v3) data comes from.

The report needs four things from Rework, one call per service for the last two:
  services        every project-app service (each belongs to a client "group")
  groups          the service groups, i.e. the clients
  resource_items  a service's workload records; each holds the timer sessions logged on a task
  work_items      a service's tasks (status, deadline, finished_at) for deliverables

Two sources return the same JSON shapes:
  DirSource  reads a folder of saved responses (tests, offline runs)
  ApiSource  calls the Rework API over HTTPS
"""

import json
import os
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
    """Rework API. Paths are set by environment so they can be fixed without a code change.

    REWORK_API_BASE   e.g. https://project.rework.com/api  (no trailing slash)
    REWORK_API_TOKEN  sent as a Bearer token
    Path templates (defaults are the Project v3 page reads the MCP connector wraps;
    confirm them with the Rework team):
      REWORK_PATH_SERVICES        /admin/services?model=project.project
      REWORK_PATH_GROUPS          /admin/service-groups
      REWORK_PATH_RESOURCE_ITEMS  /page/service-resource-items?service_id={service_id}
      REWORK_PATH_WORK_ITEMS      /page/service-workloads?service_id={service_id}
    """

    DEFAULT_PATHS = {
        "services": "/admin/services?model=project.project",
        "groups": "/admin/service-groups",
        "resource_items": "/page/service-resource-items?service_id={service_id}",
        "work_items": "/page/service-workloads?service_id={service_id}",
    }

    def __init__(self, base=None, token=None):
        self.base = (base or os.environ["REWORK_API_BASE"]).rstrip("/")
        self.token = token or os.environ["REWORK_API_TOKEN"]
        self.paths = {
            k: os.environ.get(f"REWORK_PATH_{k.upper()}", v) for k, v in self.DEFAULT_PATHS.items()
        }

    def _get(self, key, **params):
        url = self.base + self.paths[key].format(**params)
        req = urllib.request.Request(
            url, headers={"Authorization": f"Bearer {self.token}", "Accept": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)

    def services(self):
        return self._get("services").get("services", [])

    def groups(self):
        return self._get("groups").get("groups", [])

    def resource_items(self, service_id):
        return self._get("resource_items", service_id=service_id)

    def work_items(self, service_id):
        return self._get("work_items", service_id=service_id)
