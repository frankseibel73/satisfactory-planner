# Satisfactory Planner

A self-hosted production planner for Satisfactory, in the spirit of satisfactory-calculator.com's planner.
Pick products and rates; a linear-programming solver chooses recipes and reports machines, power,
raw resources, byproducts and a production graph. Plans save as JSON files.

## Run

```sh
docker compose up -d --build
```

Open http://localhost:8080. Plans are saved to `./plans/<name>.json` on the host (bind-mounted into the
container). Open one directly with `http://localhost:8080/?plan=<name>`.

You can also **Export JSON** / **Import JSON** to move plans around as files from the browser.

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
