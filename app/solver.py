"""Linear-programming production solver.

Variables
    x_r  number of machines (at 100% clock) running each enabled recipe
    s_i  raw resource drawn from the world (raw items only)
    u_i  user-supplied input used (bounded by what the user supplies)

For every item:  sum_r A[i,r] * x_r + s_i + u_i  >=  target_i
(anything above the target is reported as surplus / byproduct).

The objective minimises weighted raw resource use (weight = 1 / world limit,
so scarce resources are avoided), then power, then machine count.
"""
from collections import defaultdict

import numpy as np
from scipy.optimize import linprog

EPS = 1e-7


class Gamedata:
    def __init__(self, data):
        self.items = {i["id"]: i for i in data["items"]}
        self.recipes = {r["id"]: r for r in data["recipes"]}
        self.buildings = {b["id"]: b for b in data["buildings"]}

    def recipe_power(self, r):
        return r["power"] if r.get("power") is not None else self.buildings[r["building"]]["power"]


def solve(gd: Gamedata, plan: dict) -> dict:
    targets = defaultdict(float)
    for t in plan.get("targets", []):
        if t.get("item") in gd.items and float(t.get("rate") or 0) > 0:
            targets[t["item"]] += float(t["rate"])
    supplies = defaultdict(float)
    for s in plan.get("inputs", []):
        if s.get("item") in gd.items and float(s.get("rate") or 0) > 0:
            supplies[s["item"]] += float(s["rate"])

    if not targets:
        return {"status": "empty", "message": "Add at least one product to make."}

    settings = plan.get("settings", {})
    objective = settings.get("objective", "resources")
    limit_raw = settings.get("limitRaw", True)
    enabled = _enabled_recipes(gd, plan)

    # Only keep recipes reachable from the targets (keeps the LP small).
    recipes = _relevant(gd, enabled, set(targets))
    raws = [i for i in gd.items.values() if i["raw"]]
    sup_items = list(supplies)

    item_ids = sorted({p["item"] for r in recipes for p in r["ingredients"] + r["products"]}
                      | set(targets) | {i["id"] for i in raws} | set(sup_items))
    row = {iid: k for k, iid in enumerate(item_ids)}
    nr, ns, nu = len(recipes), len(raws), len(sup_items)
    n = nr + ns + nu

    A = np.zeros((len(item_ids), n))
    for j, r in enumerate(recipes):
        per_min = 60.0 / r["duration"]
        for p in r["products"]:
            A[row[p["item"]], j] += p["amount"] * per_min
        for p in r["ingredients"]:
            A[row[p["item"]], j] -= p["amount"] * per_min
    for k, raw in enumerate(raws):
        A[row[raw["id"]], nr + k] = 1
    for k, iid in enumerate(sup_items):
        A[row[iid], nr + ns + k] = 1
    b = np.array([targets.get(iid, 0.0) for iid in item_ids])

    # Objective weights.
    machines = np.ones(nr)
    power = np.array([gd.recipe_power(r) for r in recipes])
    raw_w = np.array([0.0 if raw["id"] == "Desc_Water_C" else 1.0 / raw["rawLimit"] for raw in raws])
    c = np.zeros(n)
    if objective == "power":
        c[:nr] = power + 1e-4 * machines
        c[nr:nr + ns] = raw_w * 1e-2 + 1e-9
    elif objective == "machines":
        c[:nr] = machines + 1e-4 * power
        c[nr:nr + ns] = raw_w * 1e-2 + 1e-9
    else:  # resources
        c[:nr] = 1e-6 * power + 1e-7 * machines
        c[nr:nr + ns] = raw_w + 1e-9
    c[nr + ns:] = 0.0  # supplied inputs are free

    bounds = [(0, None)] * nr
    bounds += [(0, raw["rawLimit"] if limit_raw else None) for raw in raws]
    bounds += [(0, supplies[iid]) for iid in sup_items]

    res = linprog(c, A_ub=-A, b_ub=-b, bounds=bounds, method="highs")
    if res.status != 0:
        return {"status": "infeasible", "message": _diagnose(gd, recipes, targets, supplies, res)}

    x = res.x
    return _report(gd, recipes, raws, sup_items, x[:nr], x[nr:nr + ns], x[nr + ns:], targets)


def _enabled_recipes(gd, plan):
    cfg = plan.get("recipes", {})
    on = set(cfg.get("enabled", []))
    off = set(cfg.get("disabled", []))
    return [r for r in gd.recipes.values()
            if (r["defaultEnabled"] or r["id"] in on) and r["id"] not in off]


def _relevant(gd, enabled, wanted):
    producers = defaultdict(list)
    for r in enabled:
        for p in r["products"]:
            producers[p["item"]].append(r)
    seen_items, keep, stack = set(), {}, list(wanted)
    while stack:
        iid = stack.pop()
        if iid in seen_items:
            continue
        seen_items.add(iid)
        for r in producers[iid]:
            if r["id"] not in keep:
                keep[r["id"]] = r
                stack.extend(p["item"] for p in r["ingredients"])
    return list(keep.values())


def _diagnose(gd, recipes, targets, supplies, res):
    made = {p["item"] for r in recipes for p in r["products"]}
    missing = [gd.items[t]["name"] for t in targets
               if t not in made and not gd.items[t]["raw"] and t not in supplies]
    if missing:
        return "No enabled recipe produces: " + ", ".join(missing) + ". Enable an alternate recipe or add it as an input."
    if res.status == 2:
        return ("The targets can't be reached with the enabled recipes and resource limits. "
                "Try lower rates, more inputs, or turning off 'Limit raw resources to world totals'.")
    return f"Solver failed: {res.message}"


def _report(gd, recipes, raws, sup_items, x, s, u, targets):
    produced = defaultdict(float)
    consumed = defaultdict(float)
    rows = []
    total_power = 0.0
    total_machines = 0.0
    building_counts = defaultdict(float)

    for r, count in zip(recipes, x):
        if count < EPS:
            continue
        pw = count * gd.recipe_power(r)
        total_power += pw
        total_machines += count
        building_counts[r["building"]] += count
        ins = [{"item": p["item"], "rate": p["amount"] * 60.0 / r["duration"] * count} for p in r["ingredients"]]
        outs = [{"item": p["item"], "rate": p["amount"] * 60.0 / r["duration"] * count} for p in r["products"]]
        for p in outs:
            produced[p["item"]] += p["rate"]
        for p in ins:
            consumed[p["item"]] += p["rate"]
        rows.append({
            "recipe": r["id"], "building": r["building"], "machines": count,
            "power": pw, "inputs": ins, "outputs": outs,
        })

    raw_used = {raw["id"]: v for raw, v in zip(raws, s) if v > EPS}
    sup_used = {iid: v for iid, v in zip(sup_items, u) if v > EPS}
    for iid, v in list(raw_used.items()) + list(sup_used.items()):
        produced[iid] += v

    surplus = {}
    for iid in set(produced) | set(targets):
        extra = produced[iid] - consumed[iid] - targets.get(iid, 0.0)
        if extra > 1e-5:
            surplus[iid] = extra

    return {
        "status": "ok",
        "rows": sorted(rows, key=lambda r: -r["machines"]),
        "raw": [{"item": k, "rate": v} for k, v in sorted(raw_used.items(), key=lambda kv: -kv[1])],
        "inputs": [{"item": k, "rate": v} for k, v in sup_used.items()],
        "targets": [{"item": k, "rate": v} for k, v in targets.items()],
        "surplus": [{"item": k, "rate": v} for k, v in sorted(surplus.items(), key=lambda kv: -kv[1])],
        "buildings": [{"building": k, "count": v} for k, v in sorted(building_counts.items(), key=lambda kv: -kv[1])],
        "totals": {"power": total_power, "machines": total_machines},
        "graph": _graph(gd, rows, raw_used, sup_used, targets, surplus),
    }


def _graph(gd, rows, raw_used, sup_used, targets, surplus):
    """Nodes plus producer->consumer edges, splitting each item's flow
    proportionally across its consumers."""
    nodes, sources, sinks = [], defaultdict(list), defaultdict(list)

    def add(nid, kind, label, sub=""):
        nodes.append({"id": nid, "kind": kind, "label": label, "sub": sub})

    for iid, v in raw_used.items():
        nid = f"raw:{iid}"
        add(nid, "raw", gd.items[iid]["name"], "")
        sources[iid].append((nid, v))
    for iid, v in sup_used.items():
        nid = f"in:{iid}"
        add(nid, "input", gd.items[iid]["name"], "supplied")
        sources[iid].append((nid, v))
    for k, row in enumerate(rows):
        nid = f"r:{k}"
        r = gd.recipes[row["recipe"]]
        add(nid, "recipe", r["name"], f"{row['machines']:.2f}× {gd.buildings[row['building']]['name']}")
        for p in row["outputs"]:
            sources[p["item"]].append((nid, p["rate"]))
        for p in row["inputs"]:
            sinks[p["item"]].append((nid, p["rate"]))
    for iid, v in targets.items():
        nid = f"out:{iid}"
        add(nid, "target", gd.items[iid]["name"], "")
        sinks[iid].append((nid, v))
    for iid, v in surplus.items():
        nid = f"sur:{iid}"
        add(nid, "surplus", gd.items[iid]["name"], "surplus")
        sinks[iid].append((nid, v))

    edges = []
    for iid, srcs in sources.items():
        total = sum(v for _, v in srcs)
        if total < EPS:
            continue
        for snode, sv in srcs:
            for dnode, dv in sinks.get(iid, []):
                flow = sv * dv / total
                if flow > 1e-6 and snode != dnode:
                    edges.append({"from": snode, "to": dnode, "item": iid, "rate": flow})
    return {"nodes": nodes, "edges": edges}
