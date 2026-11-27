# Satisfactory Planner

A self-hosted production planner for Satisfactory, in the spirit of satisfactory-calculator.com's planner.
Pick products and rates; a linear-programming solver chooses recipes and reports machines, power,
raw resources, byproducts and a production graph. Plans save as JSON files.

## Deploy (Dockerfile only)

The Dockerfile is self-contained: it clones this repo when the image is built and runs `git pull`
every time the container starts. On any server with Docker, copy just the `Dockerfile` and run:

```sh
docker build -t satisfactory-planner .
docker run -d --name planner -p 8080:8000 -v planner-plans:/data/plans --restart unless-stopped satisfactory-planner
```

Open http://<server>:8080. To update to the latest commit: `docker restart planner`.
Python dependencies are reinstalled on start only when `requirements.txt` changes.

| Setting | Default | Purpose |
|---|---|---|
| `GIT_PULL` (env) | `true` | `false` keeps the current checkout on restart |
| `REPO_URL` / `REPO_BRANCH` (build arg or env) | this repo / `main` | deploy a fork or another branch |
| `PUID` / `PGID` (env) | `1000` | owner of saved plan files (match your host user for bind mounts) |
| `/data/plans` (volume) | | where plan JSON files are stored |

To keep plans in a host folder instead of a named volume, use `-v /path/to/plans:/data/plans`.
The container takes ownership of that folder on start, then runs the app as an unprivileged user.

### docker compose

`docker compose up -d --build` does the same, saving plans to `./plans` next to the compose file.
Note that the container runs the code **from GitHub**, not your local working copy: push changes, then
`docker compose restart`.

Open a saved plan directly with `http://localhost:8080/?plan=<name>`. You can also **Export JSON** /
**Import JSON** to move plans around as files from the browser.

## Run locally without Docker

```sh
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8080
```

## Features

- Multiple products, plus **supplied inputs** (items you already produce elsewhere, up to a given rate).
- Optimise for fewest raw resources (weighted by world scarcity), lowest power, or fewest machines.
- Toggle any alternate recipe; ore-conversion (Converter) and unpackaging recipes are off by default.
- Optional cap on raw resources at world extraction totals.
- Graph (drag to pan, scroll to zoom), per-recipe machine table with clock-speed hints, and an item balance table.
- The working plan is kept in browser storage, so a refresh doesn't lose it.

Machine counts assume 100% clock speed. Power is consumption only (no generators), and variable-power
buildings use their average draw.

## Plan file format

```json
{
  "name": "Turbo Motors",
  "version": 1,
  "targets": [{ "item": "Desc_MotorLightweight_C", "rate": 2 }],
  "inputs":  [{ "item": "Desc_IronIngot_C", "rate": 100 }],
  "settings": { "objective": "resources", "limitRaw": true },
  "recipes": { "enabled": ["Recipe_Alternate_RecycledRubber_C"], "disabled": [] },
  "updated": "2026-11-27T15:46:58+00:00"
}
```

Rates are per minute (fluids in m³/min). `recipes.enabled` / `disabled` list changes from the defaults.

## Game data

`app/data/gamedata.json` is generated from the game's own docs file. After a game update, regenerate it and rebuild:

```sh
python tools/extract_data.py "E:/SteamLibrary/steamapps/common/Satisfactory/CommunityResources/Docs/en-US.json"
docker compose up -d --build
```

## Layout

- `app/main.py` – FastAPI: game data, `/api/solve`, and plan CRUD under `/api/plans`
- `app/solver.py` – LP model (scipy / HiGHS) and result/graph building
- `app/static/` – the UI (plain HTML/CSS/JS, no build step)
- `tools/extract_data.py` – game data extractor
