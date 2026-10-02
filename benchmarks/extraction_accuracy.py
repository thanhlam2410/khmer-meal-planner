#!/usr/bin/env python3
"""Extraction accuracy benchmark (model-vs-model agreement).

Reads the raw cross-check verdicts (Claude Opus 5.5 judging Gemini 2.5 Pro's extraction) from
data/cache/crosscheck/ and the extractions from data/cache/extract/, and writes:
  benchmarks/results/extraction-accuracy.json   raw numbers (per field, per image, every disputed item)
  benchmarks/results/extraction-accuracy.md     readable summary

    python3 benchmarks/extraction_accuracy.py      (stdlib only)
"""

import json
import math
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CC = ROOT / "data" / "cache" / "crosscheck"
EX = ROOT / "data" / "cache" / "extract"
OUT = ROOT / "benchmarks" / "results"
FIELDS = ["exists", "name_km_ok", "translation_ok", "price_ok", "category_ok"]
PREDICTED = {  # written in PLAN.md §5 before any image was processed
    "exists": None, "name_km_ok": "60–75%", "translation_ok": "85–90%", "price_ok": "88–93%", "category_ok": "90–95%",
}


def wilson(k: int, n: int, z: float = 1.96):
    if n == 0:
        return None, None
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return round(100 * (c - h), 1), round(100 * (c + h), 1)


def rate(verdicts, field):
    vals = [v.get(field) for v in verdicts if isinstance(v.get(field), bool)]
    k, n = sum(vals), len(vals)
    lo, hi = wilson(k, n)
    return {"agreed": k, "judged": n, "rate_pct": round(100 * k / n, 1) if n else None, "ci95_pct": [lo, hi]}


def main():
    audits = [json.loads(p.read_text()) for p in sorted(CC.glob("*.json"))]
    all_v, per_image, disputed = [], [], []
    for a in audits:
        vs = a["result"].get("items", [])
        all_v += vs
        ex = json.loads((EX / f"{a['image']}.json").read_text())
        names = {f"{Path(a['image']).stem}#{i + 1:03d}": it.get("name_en") for i, it in enumerate(ex["result"]["items"])}
        per_image.append({
            "image": a["image"],
            "items_extracted": len(ex["result"]["items"]),
            "items_judged": len(vs),
            "missing_items_reported": len(a["result"].get("missing_items") or []),
            **{f: rate(vs, f)["rate_pct"] for f in FIELDS},
            "judge_model": a.get("model"),
            "judge_cost_usd": (a.get("usage") or {}).get("cost"),
        })
        for v in vs:
            bad = [f for f in FIELDS if v.get(f) is False]
            if bad:
                disputed.append({"id": v.get("id"), "name_en": names.get(v.get("id")), "failed": bad, "note": v.get("note")})

    all_ok = sum(all(v.get(f) is not False for f in FIELDS) for v in all_v)
    lo, hi = wilson(all_ok, len(all_v))
    price_bad_images = sorted({d["id"].split("#")[0] for d in disputed if "price_ok" in d["failed"]})
    result = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "method": "Claude Opus 5.5 judged each extracted item against the menu image (true/false per field). "
        "rate = agreed / judged; 95% Wilson interval. Model-vs-model agreement, not human ground truth.",
        "sample": {
            "images_total": len(list(EX.glob("*.json"))),
            "images_audited": len(audits),
            "items_audited": len(all_v),
            "selection": "random, ceil(31 × 0.3) = 10 images, seed 42 (scripts/extraction/extract.py)",
        },
        "fields": {f: {**rate(all_v, f), "predicted": PREDICTED[f]} for f in FIELDS},
        "all_fields_correct": {"agreed": all_ok, "judged": len(all_v), "rate_pct": round(100 * all_ok / len(all_v), 1), "ci95_pct": [lo, hi]},
        "missing_items_reported": sum(p["missing_items_reported"] for p in per_image),
        "price_disputes_by_image": price_bad_images,
        "per_image": per_image,
        "disputed_items": disputed,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "extraction-accuracy.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")

    label = {"exists": "Item exists", "name_km_ok": "Khmer spelling", "translation_ok": "English meaning", "price_ok": "Price", "category_ok": "Category"}
    lines = [
        "# Extraction accuracy (model-vs-model)",
        "",
        f"Generated {result['generated_at']} by `benchmarks/extraction_accuracy.py` from `data/cache/crosscheck/`.",
        "",
        f"Sample: {len(audits)} of {result['sample']['images_total']} images, {len(all_v)} items. {result['method']}",
        "",
        "| Field | Predicted | Agreed | Rate | 95% CI |",
        "|---|---|---|---|---|",
    ]
    for f in FIELDS:
        r = result["fields"][f]
        lines.append(f"| {label[f]} | {r['predicted'] or '—'} | {r['agreed']}/{r['judged']} | {r['rate_pct']}% | {r['ci95_pct'][0]}–{r['ci95_pct'][1]}% |")
    a = result["all_fields_correct"]
    lines += [
        f"| All fields | — | {a['agreed']}/{a['judged']} | {a['rate_pct']}% | {a['ci95_pct'][0]}–{a['ci95_pct'][1]}% |",
        "",
        f"Missing items reported: {result['missing_items_reported']}. Price disputes come from: {', '.join(price_bad_images) or 'none'}.",
        "",
        "## Per image",
        "",
        "| Image | Items | Exists | Khmer | English | Price | Category | Missing |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for p in per_image:
        lines.append(f"| {p['image']} | {p['items_judged']} | {p['exists']} | {p['name_km_ok']} | {p['translation_ok']} | {p['price_ok']} | {p['category_ok']} | {p['missing_items_reported']} |")
    (OUT / "extraction-accuracy.md").write_text("\n".join(lines) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}/extraction-accuracy.json + .md ({len(all_v)} items, {len(disputed)} disputed)")


if __name__ == "__main__":
    main()
