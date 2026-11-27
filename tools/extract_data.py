"""Extract planner data from Satisfactory's CommunityResources/Docs/en-US.json.

Usage:
    python tools/extract_data.py "E:/SteamLibrary/steamapps/common/Satisfactory/CommunityResources/Docs/en-US.json"

Writes app/data/gamedata.json. Re-run after a game update.
"""
import json
import re
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "app" / "data" / "gamedata.json"

# Raw resources the solver may draw from the world, with the default world
# extraction limits (items/min, or m3/min for fluids) used for weighting.
RAW_LIMITS = {
    "Desc_OreIron_C": 92100,
    "Desc_OreCopper_C": 36900,
    "Desc_Stone_C": 69300,
    "Desc_Coal_C": 42300,
    "Desc_OreGold_C": 15000,
    "Desc_RawQuartz_C": 13500,
    "Desc_Sulfur_C": 10800,
    "Desc_OreBauxite_C": 12300,
    "Desc_OreUranium_C": 2100,
    "Desc_SAM_C": 10200,
    "Desc_LiquidOil_C": 12600,
    "Desc_NitrogenGas_C": 12000,
    "Desc_Water_C": 9007199254740991,  # effectively unlimited
}

ITEM_RE = re.compile(r"ItemClass=\"[^\"]*?\.(\w+)'?\"\s*,\s*Amount=([\d.]+)")
BUILDING_RE = re.compile(r"\.(Build_\w+?)\"")


def load(path):
    raw = Path(path).read_bytes()
    enc = "utf-16" if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else "utf-8-sig"
    return json.loads(raw.decode(enc))


def short_class(native):
    return native.split(".")[-1].rstrip("'")


def parse_items(s):
    return [(cls, float(amt)) for cls, amt in ITEM_RE.findall(s or "")]


def main(src):
    docs = load(src)
    groups = {short_class(g["NativeClass"]): g["Classes"] for g in docs}

    # Every descriptor-like class with a display name is a potential item.
    descs = {}
    for name, classes in groups.items():
        for c in classes:
            if "mForm" in c and c.get("mDisplayName"):
                descs[c["ClassName"]] = c

    # Every buildable with a power value is a potential production building.
    buildings = {}
    for name, classes in groups.items():
        if not name.startswith("FGBuildable"):
            continue
        for c in classes:
            if not c["ClassName"].startswith("Build_"):
                continue
            power = float(c.get("mPowerConsumption") or 0)
            pmin = c.get("mEstimatedMininumPowerConsumption")
            pmax = c.get("mEstimatedMaximumPowerConsumption")
            variable = pmin is not None and pmax is not None and power == 0
            buildings[c["ClassName"]] = {
                "id": c["ClassName"],
                "name": c["mDisplayName"],
                "power": (float(pmin) + float(pmax)) / 2 if variable else power,
                "powerMin": float(pmin) if variable else power,
                "powerMax": float(pmax) if variable else power,
                "variablePower": variable,
            }

    recipes = []
    used_items = set(RAW_LIMITS)
    used_buildings = set()
    for c in groups["FGRecipe"]:
        produced = [b for b in BUILDING_RE.findall(c.get("mProducedIn", "")) if b in buildings]
        if not produced:
            continue  # build-gun / workshop only
        products = parse_items(c["mProduct"])
        ingredients = parse_items(c["mIngredients"])
        if not products or any(p not in descs for p, _ in products + ingredients):
            continue
        b = produced[0]
        fluid = lambda cls: descs[cls]["mForm"] in ("RF_LIQUID", "RF_GAS")
        norm = lambda lst: [
            {"item": cls, "amount": amt / 1000 if fluid(cls) else amt} for cls, amt in lst
        ]
        rid = c["ClassName"]
        alternate = "Alternate" in rid or c["mDisplayName"].startswith("Alternate:")
        makes_raw = products[0][0] in RAW_LIMITS  # primary product only
        power = None
        if buildings[b]["variablePower"]:
            const = float(c.get("mVariablePowerConsumptionConstant") or 0)
            factor = float(c.get("mVariablePowerConsumptionFactor") or 0)
            power = const + factor / 2  # average over the cycle
        recipes.append({
            "id": rid,
            "name": c["mDisplayName"],
            "building": b,
            "duration": float(c["mManufactoringDuration"]),
            "ingredients": norm(ingredients),
            "products": norm(products),
            "alternate": alternate,
            "power": power,  # MW override for variable-power buildings
            # Ore-to-ore conversions are off by default, like alternates.
            "defaultEnabled": not alternate and not makes_raw,
        })
        used_buildings.add(b)
        used_items.update(cls for cls, _ in products + ingredients)

    items = []
    for cls in sorted(used_items, key=lambda k: descs[k]["mDisplayName"]):
        d = descs[cls]
        items.append({
            "id": cls,
            "name": d["mDisplayName"],
            "fluid": d["mForm"] in ("RF_LIQUID", "RF_GAS"),
            "raw": cls in RAW_LIMITS,
            "rawLimit": RAW_LIMITS.get(cls),
            "sinkPoints": int(float(d.get("mResourceSinkPoints") or 0)),
        })

    data = {
        "source": str(src),
        "items": items,
        "recipes": sorted(recipes, key=lambda r: r["name"]),
        "buildings": [buildings[b] for b in sorted(used_buildings)],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=1), encoding="utf-8")
    print(f"Wrote {OUT}: {len(items)} items, {len(recipes)} recipes, {len(used_buildings)} buildings")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
