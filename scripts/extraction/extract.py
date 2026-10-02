#!/usr/bin/env python3
"""Offline menu extraction: images -> structured, translated, USD-priced dataset.

    scripts/extraction/.venv/bin/python scripts/extraction/extract.py [options]
    (setup: uv venv scripts/extraction/.venv && uv pip install -p scripts/extraction/.venv/bin/python -r scripts/extraction/requirements.txt)

Stages (each cached under data/cache/, so re-runs only redo what's missing):
  1. prepare     PNG -> JPEG (Pillow, full resolution, EXIF-rotated) to keep uploads small
  2. extract     EXTRACT_MODEL reads Khmer text, translates to English, returns JSON
  3. crosscheck  CROSSCHECK_MODEL audits a random sample of images item-by-item
  4. build       normalise prices to USD, group images into restaurants,
                 write data/menus.json + data/extraction-report.json

Env (.env is loaded automatically): OPENROUTER_API_KEY, EXTRACT_MODEL,
CROSSCHECK_MODEL, RIEL_PER_USD (default 4000)
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import random
import re
import sys
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageOps

from llm import ROOT, USAGE_LOG, chat_json, image_part, load_env, now_iso
from prompts import CROSSCHECK_SYSTEM, EXTRACT_SYSTEM, crosscheck_user_prompt, extract_user_prompt

load_env()

# ---------- config ----------
RAW_DIR = ROOT / "data" / "raw"  # images may sit in sub-folders: one folder = one restaurant
CACHE_JPEG = ROOT / "data" / "cache" / "jpeg"
CACHE_EXTRACT = ROOT / "data" / "cache" / "extract"
CACHE_CROSSCHECK = ROOT / "data" / "cache" / "crosscheck"
OVERRIDES_FILE = ROOT / "data" / "restaurant-overrides.json"  # optional: {"image.png": "restaurant-id"}
FIXES_FILE = ROOT / "data" / "manual-fixes.json"  # optional: hand corrections to items
NAMES_FILE = ROOT / "data" / "restaurant-names.json"  # optional: {"<raw sub-folder>": {"name_en", "name_km", "evidence"}}
OUT_MENUS = ROOT / "data" / "menus.json"
OUT_REPORT = ROOT / "data" / "extraction-report.json"

EXTRACT_MODEL = os.environ.get("EXTRACT_MODEL") or "google/gemini-2.5-pro"
CROSSCHECK_MODEL = os.environ.get("CROSSCHECK_MODEL") or "anthropic/claude-opus-5.5"
RIEL_PER_USD = float(os.environ.get("RIEL_PER_USD") or 4000)
NEIGHBOUR_GAP_SEC = 180
BEVERAGE_CATEGORIES = {"beer", "alcohol", "soft_drink", "coffee_tea", "juice", "water"}  # an unnamed image inherits the previous image's restaurant if taken within 3 min


def log(msg: str) -> None:
    print(f"[extract] {msg}", flush=True)


# ---------- io helpers ----------
def read_json(p: Path):
    return json.loads(p.read_text())


def maybe_json(p: Path):
    return read_json(p) if p.exists() else None


def write_json(p: Path, v) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(v, indent=2, ensure_ascii=False) + "\n")


def cost(usage: dict | None) -> float:
    return round(float((usage or {}).get("cost") or 0), 4)


def extract_path(img: str) -> Path:
    return CACHE_EXTRACT / f"{img}.json"


def crosscheck_path(img: str) -> Path:
    return CACHE_CROSSCHECK / f"{img}.json"


def item_id(img: str, i: int) -> str:
    return f"{Path(img).stem}#{i + 1:03d}"


# ---------- raw images ----------
IMAGE_RE = re.compile(r"\.(png|jpe?g)$", re.I)


def scan_images() -> dict[str, Path]:
    """Map image file name -> path, searching data/raw recursively. File names must be unique."""
    found: dict[str, Path] = {}
    for f in sorted(RAW_DIR.rglob("*")):
        if f.is_file() and IMAGE_RE.search(f.name):
            if f.name in found:
                raise SystemExit(f"duplicate image name {f.name}: {found[f.name]} and {f}")
            found[f.name] = f
    return found


IMAGE_PATHS: dict[str, Path] = {}


def image_folder(img: str) -> str | None:
    """Sub-folder of data/raw holding this image (the manual restaurant grouping), or None."""
    parent = IMAGE_PATHS[img].parent
    return None if parent == RAW_DIR else parent.relative_to(RAW_DIR).as_posix()


# ---------- stage 1: prepare ----------
def jpeg_path(img: str) -> Path:
    return CACHE_JPEG / f"{Path(img).stem}.jpg"


def prepare_jpeg(img: str) -> None:
    out = jpeg_path(img)
    if out.exists():
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(IMAGE_PATHS[img]) as im:
        ImageOps.exif_transpose(im).convert("RGB").save(out, "JPEG", quality=90)


def jpeg_base64(img: str) -> str:
    return base64.b64encode(jpeg_path(img).read_bytes()).decode()


# ---------- stage 2: extract ----------
def validate_extraction(result: dict, img: str) -> None:
    if not isinstance(result, dict) or not isinstance(result.get("items"), list):
        raise ValueError(f'no "items" array for {img}')
    result["items"] = [
        it for it in result["items"] if isinstance(it, dict) and (it.get("name_km") or it.get("name_en") or it.get("name_printed_latin"))
    ]
    for it in result["items"]:
        it["prices"] = it["prices"] if isinstance(it.get("prices"), list) else []
        it["tags"] = it["tags"] if isinstance(it.get("tags"), list) else []


def run_extract(img: str, force: bool) -> None:
    out = extract_path(img)
    if out.exists() and not force:
        return
    t0 = time.time()
    try:
        r = chat_json(
            EXTRACT_MODEL,
            [
                {"role": "system", "content": EXTRACT_SYSTEM},
                {"role": "user", "content": [{"type": "text", "text": extract_user_prompt(img)}, image_part(jpeg_base64(img))]},
            ],
            meta={"script": "extract", "stage": "extract", "image": img},
        )
        result = r["json"]
        validate_extraction(result, img)
        secs = round(time.time() - t0, 1)
        write_json(out, {"image": img, "model": r["model"], "extracted_at": now_iso(), "seconds": secs, "usage": r["usage"], "result": result})
        name = (result.get("restaurant") or {}).get("name_en") or "(no name)"
        log(f"✓ extract {img}: {len(result['items'])} items, {name} ({secs}s, ${cost(r['usage'])})")
    except Exception as err:
        log(f"✗ extract {img}: {err}")


# ---------- stage 3: crosscheck ----------
def items_for_audit(img: str) -> list[dict]:
    result = read_json(extract_path(img))["result"]
    return [
        {
            "id": item_id(img, i),
            "name_km": it.get("name_km"),
            "name_printed_latin": it.get("name_printed_latin"),
            "name_en": it.get("name_en"),
            "category": it.get("category"),
            "tags": it.get("tags"),
            "prices": [{k: p.get(k) for k in ("price_text", "amount", "currency", "variant_en")} for p in it.get("prices", [])],
        }
        for i, it in enumerate(result["items"])
    ]


def is_agree(v: dict) -> bool:
    return all(v.get(k) is not False for k in ("exists", "name_km_ok", "translation_ok", "price_ok", "category_ok"))


def sample_images(images: list[str], rate: float, seed: int) -> list[str]:
    n = min(len(images), max(1, math.ceil(len(images) * rate)))
    return sorted(random.Random(seed).sample(images, n))


def run_crosscheck(img: str, force: bool) -> None:
    out = crosscheck_path(img)
    if out.exists() and not force:
        return
    t0 = time.time()
    try:
        items = items_for_audit(img)
        r = chat_json(
            CROSSCHECK_MODEL,
            [
                {"role": "system", "content": CROSSCHECK_SYSTEM},
                {"role": "user", "content": [{"type": "text", "text": crosscheck_user_prompt(items)}, image_part(jpeg_base64(img))]},
            ],
            meta={"script": "extract", "stage": "crosscheck", "image": img},
        )
        result = r["json"]
        secs = round(time.time() - t0, 1)
        write_json(out, {"image": img, "model": r["model"], "checked_at": now_iso(), "seconds": secs, "usage": r["usage"], "result": result})
        bad = sum(1 for v in result.get("items", []) if not is_agree(v))
        log(f"✓ crosscheck {img}: {bad}/{len(items)} disputed, {len(result.get('missing_items') or [])} missing ({secs}s, ${cost(r['usage'])})")
    except Exception as err:
        log(f"✗ crosscheck {img}: {err}")


# ---------- stage 4: build ----------
KHMER_DIGITS = str.maketrans("០១២៣៤៥៦៧៨៩", "0123456789")


def parse_number(s: str, currency: str) -> float:
    t = re.sub(r"\s", "", s)
    if currency == "KHR":  # riel: separators are thousands
        return float(re.sub(r"[.,]", "", t))
    if re.fullmatch(r"\d{1,3}(,\d{3})+", t):
        return float(t.replace(",", ""))
    return float(t.replace(",", ".", 1))


def normalise_price(p: dict) -> dict:
    """Re-derive the amount from the literal printed text (Khmer numerals -> ASCII) and convert
    to USD in code. Disagreements with the model's own reading are flagged, not hidden."""
    text = str(p.get("price_text") or "")
    ascii_text = text.translate(KHMER_DIGITS)
    if re.search(r"\$|usd", ascii_text, re.I):
        currency = "USD"
    elif re.search(r"៛|riel|\bR\b", ascii_text, re.I):
        currency = "KHR"
    else:
        currency = "USD" if p.get("currency") == "USD" else "KHR"
    flags: list[str] = []

    nums = []
    for m in re.finditer(r"\d[\d.,\s]*\d|\d", ascii_text):
        try:
            nums.append(parse_number(m.group(0).strip(), currency))
        except ValueError:
            pass
    model_amount = p.get("amount") if isinstance(p.get("amount"), (int, float)) else None
    amount = next((n for n in nums if n == model_amount), None)
    if amount is None:
        amount = max(nums) if nums else model_amount
    if amount is None:
        flags.append("unparsed_price_text")
    if model_amount is not None and amount != model_amount:
        flags.append("model_amount_differs")
    if p.get("currency") and p.get("currency") != currency:
        flags.append("currency_differs_from_model")
    if currency == "KHR" and amount is not None and amount < 100:
        flags.append("suspect_low_riel")
    if currency == "USD" and amount is not None and amount > 100:
        flags.append("suspect_high_usd")

    usd = None if amount is None else (amount if currency == "USD" else amount / RIEL_PER_USD)
    if isinstance(amount, float) and amount.is_integer():
        amount = int(amount)
    return {
        "price_text": text,
        "amount": amount,
        "currency": currency,
        "price_usd": None if usd is None else round(usd + 1e-9, 2),
        "variant_en": p.get("variant_en"),
        "variant_km": p.get("variant_km"),
        "unit_en": p.get("unit_en"),
        "unit_km": p.get("unit_km"),
        "flags": flags,
    }


def restaurant_id(r: dict) -> str:
    base = unicodedata.normalize("NFKD", (r.get("name_en") or "").lower())
    base = re.sub(r"[^a-z0-9]+", "-", base).strip("-")
    if base:
        return base
    return "km-" + hashlib.sha1((r.get("name_km") or "").encode()).hexdigest()[:8]


def image_time(img: str) -> float:
    m = re.match(r"^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})", img)
    if not m:
        return math.nan
    return datetime.fromisoformat(f"{m[1]}T{m[2]}:{m[3]}:{m[4]}").timestamp()


def build(images: list[str]) -> None:
    overrides = read_json(OVERRIDES_FILE) if OVERRIDES_FILE.exists() else {}
    pages = [
        {"img": img, "ext": read_json(extract_path(img)), "cc": maybe_json(crosscheck_path(img))}
        for img in images
        if extract_path(img).exists()
    ]

    restaurants: dict[str, dict] = {}
    prev = None
    for p in pages:
        r = p["ext"]["result"].get("restaurant") or {}
        folder = image_folder(p["img"])
        if p["img"] in overrides:
            rid, source = overrides[p["img"]], "override"
        elif folder:
            rid, source = f"folder-{folder}", "folder"
        elif r.get("visible") and (r.get("name_en") or r.get("name_km")):
            rid, source = restaurant_id(r), "visible"
        elif prev and abs(image_time(p["img"]) - image_time(prev["img"])) <= NEIGHBOUR_GAP_SEC:
            rid, source = prev["restaurant_id"], "inferred_from_previous_image"
        else:
            rid, source = f"unknown-{Path(p['img']).stem}", "unknown"

        rest = restaurants.setdefault(
            rid, {"id": rid, "name_en": None, "name_km": None, "name_source": source, "name_candidates": [], "images": [], "items": []}
        )
        if r.get("visible") and (r.get("name_en") or r.get("name_km")):
            cand = {"name_en": r.get("name_en"), "name_km": r.get("name_km"), "image": p["img"]}
            if all((c["name_en"], c["name_km"]) != (cand["name_en"], cand["name_km"]) for c in rest["name_candidates"]):
                rest["name_candidates"].append(cand)
        if r.get("visible"):
            rest["name_en"] = rest["name_en"] or r.get("name_en")
            rest["name_km"] = rest["name_km"] or r.get("name_km")
            rest["name_source"] = source if source in ("override", "folder") else "visible"
        rest["images"].append({"file": p["img"], "restaurant_source": source, "image_quality": p["ext"]["result"].get("image_quality")})
        p["restaurant_id"] = rid
        prev = p

        audit = {v.get("id"): v for v in ((p["cc"] or {}).get("result") or {}).get("items", [])}
        for i, it in enumerate(p["ext"]["result"]["items"]):
            iid = item_id(p["img"], i)
            prices = [normalise_price(x) for x in it.get("prices", [])]
            usd = [x["price_usd"] for x in prices if x["price_usd"] is not None]
            v = audit.get(iid)
            if not p["cc"]:
                crosscheck = None
            elif v is None:
                crosscheck = {"verdict": "not_returned"}
            else:
                crosscheck = {
                    "verdict": "agree" if is_agree(v) else "disagree",
                    **{k: v.get(k) for k in ("name_km_ok", "translation_ok", "price_ok", "category_ok", "exists", "correct_prices", "note")},
                }
            rest["items"].append(
                {
                    "id": iid,
                    "name_en": it.get("name_en"),
                    "name_km": it.get("name_km"),
                    "name_printed_latin": it.get("name_printed_latin"),
                    "description_en": it.get("description_en"),
                    "section_en": it.get("section_en"),
                    "section_km": it.get("section_km"),
                    "kind": "beverage" if (it.get("category") or "other") in BEVERAGE_CATEGORIES else "food",
                    "category": it.get("category") or "other",
                    "tags": it.get("tags", []),
                    "prices": prices,
                    "min_price_usd": min(usd) if usd else None,
                    "confidence": it.get("confidence") if isinstance(it.get("confidence"), (int, float)) else None,
                    "notes": it.get("notes"),
                    "source_image": p["img"],
                    "crosscheck": crosscheck,
                }
            )

    # Folder groups: apply manual names, then give each a readable id from its name.
    names = {k: v for k, v in (read_json(NAMES_FILE) if NAMES_FILE.exists() else {}).items() if not k.startswith("_")}
    for r in restaurants.values():
        folder = r["id"][len("folder-") :] if r["id"].startswith("folder-") else None
        if folder and folder in names:
            r["name_en"], r["name_km"] = names[folder].get("name_en"), names[folder].get("name_km")
            r["name_source"], r["name_evidence"] = "manual", names[folder].get("evidence")
        elif folder and not r["name_en"]:
            r["name_en"] = f"Unnamed restaurant #{folder}"
            r["name_source"] = "none"
    taken = set(restaurants)
    for r in restaurants.values():
        if r["id"].startswith("folder-"):
            new_id = restaurant_id(r) if r["name_source"] != "none" else f"restaurant-{r['id'][len('folder-'):]}"
            if new_id not in taken:
                taken.add(new_id)
                for p in pages:
                    if p["restaurant_id"] == r["id"]:
                        p["restaurant_id"] = new_id
                r["folder"], r["id"] = r["id"][len("folder-"):], new_id

    apply_manual_fixes(restaurants.values())

    rlist = []
    for r in restaurants.values():
        if not r["name_en"]:
            r["name_en"] = f"Unnamed restaurant ({r['images'][0]['file']})" if r["id"].startswith("unknown-") else r["id"]
        rlist.append(r)
    item_count = sum(len(r["items"]) for r in rlist)

    write_json(
        OUT_MENUS,
        {
            "meta": {
                "generated_at": now_iso(),
                "extract_model": EXTRACT_MODEL,
                "crosscheck_model": CROSSCHECK_MODEL,
                "riel_per_usd": RIEL_PER_USD,
                "source_images": len(pages),
                "restaurants": len(rlist),
                "items": item_count,
                "note": "Original Khmer text is kept in *_km fields and prices[].price_text. USD prices are computed in code at a fixed rate.",
            },
            "restaurants": rlist,
        },
    )
    write_json(OUT_REPORT, report(pages, rlist))
    log(f"built {OUT_MENUS.relative_to(ROOT)}: {len(rlist)} restaurants, {item_count} items from {len(pages)} images")


def apply_manual_fixes(restaurants) -> None:
    """Apply data/manual-fixes.json: set fields, add tags, add price flags; note the reason on the item."""
    if not FIXES_FILE.exists():
        return
    by_id = {it["id"]: it for r in restaurants for it in r["items"]}
    applied = 0
    for fix in read_json(FIXES_FILE).get("fixes", []):
        for iid in fix.get("items", []):
            it = by_id.get(iid)
            if not it:
                log(f"manual fix: item {iid} not found")
                continue
            it.update(fix.get("set", {}))
            if it.get("category") in BEVERAGE_CATEGORIES:
                it["kind"] = "beverage"
            elif "category" in fix.get("set", {}):
                it["kind"] = "food"
            it["tags"] = list(dict.fromkeys(it["tags"] + fix.get("add_tags", [])))
            for p in it["prices"]:
                p["flags"] = list(dict.fromkeys(p["flags"] + fix.get("add_price_flags", [])))
            it.setdefault("manual_fix", [])
            it["manual_fix"].append(fix.get("reason"))
            applied += 1
    log(f"manual fixes applied to {applied} items")


def report(pages: list[dict], restaurants: list[dict]) -> dict:
    audited = [p for p in pages if p["cc"]]
    verdicts = [v for p in audited for v in (p["cc"].get("result") or {}).get("items", [])]

    def rate(field: str):
        vals = [v.get(field) for v in verdicts if isinstance(v.get(field), bool)]
        return round(100 * sum(vals) / len(vals), 1) if vals else None

    all_items = [it for r in restaurants for it in r["items"]]
    flagged = [it for it in all_items if any(p["flags"] for p in it["prices"]) or (it["crosscheck"] or {}).get("verdict") == "disagree"]
    missing = [{"image": p["img"], **m} for p in audited for m in ((p["cc"].get("result") or {}).get("missing_items") or [])]
    return {
        "generated_at": now_iso(),
        "models": {"extract": EXTRACT_MODEL, "crosscheck": CROSSCHECK_MODEL},
        "cost_usd": {
            "extract": round(sum(cost(p["ext"].get("usage")) for p in pages), 4),
            "crosscheck": round(sum(cost(p["cc"].get("usage")) for p in audited), 4),
        },
        "images": [
            {
                "file": p["img"],
                "restaurant": p["restaurant_id"],
                "items": len(p["ext"]["result"]["items"]),
                "image_quality": p["ext"]["result"].get("image_quality"),
                "rotation_degrees": p["ext"]["result"].get("rotation_degrees"),
                "audited": bool(p["cc"]),
            }
            for p in pages
        ],
        "crosscheck": {
            "images_audited": len(audited),
            "items_audited": len(verdicts),
            "agreement_pct": {
                "overall": round(100 * sum(map(is_agree, verdicts)) / len(verdicts), 1) if verdicts else None,
                "exists": rate("exists"),
                "name_km": rate("name_km_ok"),
                "translation": rate("translation_ok"),
                "price": rate("price_ok"),
                "category": rate("category_ok"),
            },
            "missing_items_reported": len(missing),
            "missing_items": missing,
        },
        "restaurants": [
            {
                "id": r["id"],
                "folder": r.get("folder"),
                "name_en": r["name_en"],
                "name_source": r["name_source"],
                "name_candidates": [c["name_en"] or c["name_km"] for c in r["name_candidates"]],
                "images": [i["file"] for i in r["images"]],
                "items": len(r["items"]),
            }
            for r in restaurants
        ],
        "items_needing_review": [
            {
                "id": it["id"],
                "name_en": it["name_en"],
                "name_km": it["name_km"],
                "prices": [f"{p['price_text']} -> ${p['price_usd']}" + (f" [{', '.join(p['flags'])}]" if p["flags"] else "") for p in it["prices"]],
                "crosscheck": {"note": it["crosscheck"].get("note"), "correct_prices": it["crosscheck"].get("correct_prices")}
                if (it["crosscheck"] or {}).get("verdict") == "disagree"
                else None,
            }
            for it in flagged
        ],
    }


def summarise_usage(since: str) -> None:
    """Per-run totals from logs/llm-usage.jsonl."""
    if not USAGE_LOG.exists():
        return
    rows = [json.loads(l) for l in USAGE_LOG.read_text().splitlines() if l.strip()]
    rows = [r for r in rows if r.get("ts", "") >= since]
    if not rows:
        log("usage: no model calls this run")
        return
    by: dict[str, dict] = {}
    for r in rows:
        k = f"{r.get('stage')} · {r.get('model_requested')}"
        b = by.setdefault(k, {"calls": 0, "failed": 0, "cost": 0.0, "tokens": 0})
        b["calls"] += 1
        b["failed"] += 0 if r.get("ok") else 1
        b["cost"] += float(r.get("cost_usd") or 0)
        b["tokens"] += int(r.get("prompt_tokens") or 0) + int(r.get("completion_tokens") or 0)
    for k, b in by.items():
        log(f"usage {k}: {b['calls']} calls ({b['failed']} failed), {b['tokens']} tokens, ${round(b['cost'], 4)}")
    log(f"usage total this run: ${round(sum(float(r.get('cost_usd') or 0) for r in rows), 4)} → {USAGE_LOG.relative_to(ROOT)}")


# ---------- main ----------
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", help="comma-separated image names to process")
    ap.add_argument("--limit", type=int, help="process only the first N images (sorted by time)")
    ap.add_argument("--force", action="store_true", help="re-run extraction even if cached")
    ap.add_argument("--force-crosscheck", action="store_true", help="re-run cross-check even if cached")
    ap.add_argument("--skip-extract", action="store_true", help="don't call the extraction model (use cache)")
    ap.add_argument("--crosscheck-rate", type=float, default=0.3, help="fraction of images to audit (0 disables; default 0.3)")
    ap.add_argument("--seed", type=int, default=42, help="random seed for the audit sample")
    ap.add_argument("--concurrency", type=int, default=3, help="parallel model calls")
    ap.add_argument("--build-only", action="store_true", help="skip all model calls; rebuild outputs from cache")
    args = ap.parse_args()

    run_start = now_iso()
    IMAGE_PATHS.update(scan_images())
    all_images = sorted(IMAGE_PATHS)  # file names are timestamps, so this is shooting order
    images = all_images
    if args.only:
        wanted = {s.strip() for s in args.only.split(",")}
        images = [f for f in images if f in wanted]
    if args.limit:
        images = images[: args.limit]
    log(f"images: {len(images)}/{len(all_images)} · extract={EXTRACT_MODEL} · crosscheck={CROSSCHECK_MODEL} · {RIEL_PER_USD:g}៛/$")

    if not args.build_only:
        for img in images:
            prepare_jpeg(img)

        if not args.skip_extract:
            with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
                list(ex.map(lambda img: run_extract(img, args.force), images))

        if args.crosscheck_rate > 0:
            extracted = [img for img in images if extract_path(img).exists()]
            sample = sample_images(extracted, args.crosscheck_rate, args.seed) if extracted else []
            log(f"cross-checking {len(sample)}/{len(extracted)} images: {', '.join(sample)}")
            with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
                list(ex.map(lambda img: run_crosscheck(img, args.force_crosscheck), sample))

    build(all_images)
    summarise_usage(run_start)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
