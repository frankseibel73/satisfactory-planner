import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .solver import Gamedata, solve

BASE = Path(__file__).resolve().parent
PLANS_DIR = Path(os.environ.get("PLANS_DIR", BASE.parent / "plans"))
PLANS_DIR.mkdir(parents=True, exist_ok=True)

GAMEDATA_RAW = json.loads((BASE / "data" / "gamedata.json").read_text(encoding="utf-8"))
GAMEDATA_RAW.pop("source", None)
GD = Gamedata(GAMEDATA_RAW)

app = FastAPI(title="Satisfactory Planner")


@app.get("/api/data")
def data():
    return GAMEDATA_RAW


@app.post("/api/solve")
def solve_plan(plan: dict):
    return solve(GD, plan)


def _slug(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:80]
    if not slug:
        raise HTTPException(400, "Plan name must contain letters or digits.")
    return slug


def _path(slug: str) -> Path:
    if not re.fullmatch(r"[a-z0-9-]{1,80}", slug):
        raise HTTPException(400, "Invalid plan id.")
    return PLANS_DIR / f"{slug}.json"


@app.get("/api/plans")
def list_plans():
    plans = []
    for f in sorted(PLANS_DIR.glob("*.json")):
        try:
            p = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        plans.append({"id": f.stem, "name": p.get("name", f.stem), "updated": p.get("updated")})
    return sorted(plans, key=lambda p: p.get("updated") or "", reverse=True)


@app.get("/api/plans/{slug}")
def get_plan(slug: str):
    path = _path(slug)
    if not path.exists():
        raise HTTPException(404, "Plan not found.")
    return json.loads(path.read_text(encoding="utf-8"))


@app.put("/api/plans")
def save_plan(plan: dict):
    name = str(plan.get("name") or "").strip()
    slug = _slug(name)
    plan = {**plan, "name": name, "version": 1,
            "updated": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    plan.pop("result", None)
    _path(slug).write_text(json.dumps(plan, indent=2), encoding="utf-8")
    return {"id": slug, "updated": plan["updated"]}


@app.delete("/api/plans/{slug}")
def delete_plan(slug: str):
    path = _path(slug)
    if not path.exists():
        raise HTTPException(404, "Plan not found.")
    path.unlink()
    return {"ok": True}


app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")


@app.get("/")
def index():
    return FileResponse(BASE / "static" / "index.html")
