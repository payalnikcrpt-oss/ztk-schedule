"""Збирає data/a20.json з сайту ЗТК.

Онлайн (так працює GitHub Actions):
    python scripts/build_data.py

Офлайн-тест на локальних PDF:
    python scripts/build_data.py --main-pdf розклад.pdf --changes-pdf 06.10.2026.pdf --out /tmp/a20.json

Нічого про предмети, викладачів, аудиторії тут не зашито: усе береться з PDF.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timedelta
from urllib.parse import urljoin, unquote
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(__file__))
from changes_parser import parse_changes          # noqa: E402
from schedule_parser import ParseError, parse_main_schedule  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATE_RE = re.compile(r"\b(\d{2})\.(\d{2})\.(\d{4})\b")


def load_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def http_get(url, cfg, binary=False):
    import requests
    r = requests.get(url, headers={"User-Agent": cfg["user_agent"]}, timeout=40)
    r.raise_for_status()
    return r.content if binary else r.text


def find_links(cfg):
    """(посилання на PDF розкладу курсу, {дата: url заміни}) зі сторінки сайту."""
    from bs4 import BeautifulSoup
    html = http_get(cfg["page_url"], cfg)
    soup = BeautifulSoup(html, "html.parser")
    course = str(cfg["course"])
    main_re = re.compile(r"розклад.*\b" + course + r"\s*курс", re.IGNORECASE)
    main_url, changes = None, {}
    for a in soup.find_all("a", href=True):
        text = " ".join(a.get_text(" ").split())
        href = urljoin(cfg["page_url"], a["href"])
        if main_url is None and main_re.search(text):
            main_url = href
        m = DATE_RE.search(text) or DATE_RE.search(unquote(href))
        if m:
            d, mo, y = m.groups()
            changes[f"{y}-{mo}-{d}"] = href
    return main_url, changes


def probe_changes(cfg, today, known):
    """Запасний шлях: пробуємо files/DD.MM.YYYY.pdf на найближчі дні."""
    found = {}
    for i in range(cfg["probe_days_ahead"] + 1):
        d = today + timedelta(days=i)
        key = d.strftime("%Y-%m-%d")
        if key in known:
            continue
        url = f"{cfg['files_base']}{d.strftime('%d.%m.%Y')}.pdf"
        try:
            data = http_get(url, cfg, binary=True)
        except Exception:
            continue
        if data[:4] == b"%PDF":
            found[key] = url
    return found


def download_pdf(url, cfg):
    data = http_get(url, cfg, binary=True)
    if data[:4] != b"%PDF":
        raise ValueError(f"{url} не є PDF")
    fd, path = tempfile.mkstemp(suffix=".pdf")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return path, hashlib.sha256(data).hexdigest()


def stable(d):
    """Дані без полів-часів, щоб не робити зайвих комітів."""
    d = json.loads(json.dumps(d))
    d.get("meta", {}).pop("generated_at", None)
    d.get("meta", {}).pop("main_checked_at", None)
    return d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(ROOT, "config.json"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "a20.json"))
    ap.add_argument("--main-pdf")
    ap.add_argument("--changes-pdf", action="append", default=[])
    args = ap.parse_args()

    cfg = load_json(args.config)
    tz = ZoneInfo(cfg["timezone"])
    now = datetime.now(tz)
    today = now.date()
    old = load_json(args.out, {}) or {}
    old_meta = old.get("meta", {})
    warnings, errors = [], []
    offline = bool(args.main_pdf or args.changes_pdf)

    # ---------- основний розклад ----------
    schedule, main_url, main_sha = old.get("schedule"), old_meta.get("main_pdf_url"), old_meta.get("main_pdf_sha256")
    main_checked_at = old_meta.get("main_checked_at")
    page_changes = {}

    try:
        if args.main_pdf:
            res = parse_main_schedule(args.main_pdf, cfg["group"])
            schedule, main_url, main_sha = res["schedule"], args.main_pdf, None
            warnings += res["warnings"]
            main_checked_at = now.isoformat(timespec="seconds")
        elif not offline:
            link, page_changes = find_links(cfg)
            link = link or cfg.get("main_pdf_fallback_url") or main_url
            if not link:
                raise ParseError("Не знайшов на сторінці посилання на розклад курсу")
            fresh = False
            if main_checked_at and link == main_url and schedule:
                age = now - datetime.fromisoformat(main_checked_at)
                fresh = age < timedelta(hours=cfg["main_recheck_hours"])
            if not fresh:
                path, sha = download_pdf(link, cfg)
                try:
                    if sha != main_sha or link != main_url or not schedule:
                        res = parse_main_schedule(path, cfg["group"])
                        schedule, main_url, main_sha = res["schedule"], link, sha
                        warnings += res["warnings"]
                finally:
                    os.remove(path)
                main_checked_at = now.isoformat(timespec="seconds")
    except Exception as e:  # залишаємо попередній розклад, але повідомляємо про помилку
        errors.append(f"Основний розклад: {e}")

    # ---------- заміни ----------
    changes = {k: v for k, v in (old.get("changes") or {}).items()
               if k >= today.strftime("%Y-%m-%d")}
    try:
        if args.changes_pdf:
            for p in args.changes_pdf:
                r = parse_changes(p, cfg["group"])
                if r["date"]:
                    changes[r["date"]] = r["changes"]
        elif not offline:
            urls = {k: v for k, v in page_changes.items() if k >= today.strftime("%Y-%m-%d")}
            urls.update(probe_changes(cfg, today, urls))
            for key, url in sorted(urls.items()):
                try:
                    path, _ = download_pdf(url, cfg)
                    try:
                        r = parse_changes(path, cfg["group"])
                    finally:
                        os.remove(path)
                    if r["rows_total"] == 0:
                        warnings.append(f"Заміни {key}: у PDF не знайдено жодного рядка таблиці")
                    changes[r["date"] or key] = r["changes"]
                except Exception as e:
                    errors.append(f"Заміни {key}: {e}")
    except Exception as e:
        errors.append(f"Заміни: {e}")

    if schedule is None:
        print("ПОМИЛКА: немає розкладу.", *errors, sep="\n  ", file=sys.stderr)
        sys.exit(1)

    new = {
        "meta": {
            "group": cfg["group"],
            "generated_at": now.isoformat(timespec="seconds"),
            "main_pdf_url": main_url,
            "main_pdf_sha256": main_sha,
            "main_checked_at": main_checked_at,
            "changes_dates": sorted(changes),
            "warnings": warnings,
            "errors": errors,
        },
        "schedule": schedule,
        "changes": dict(sorted(changes.items())),
    }

    # пишемо, лише якщо щось змінилось або минула доба (heartbeat для Actions)
    same = stable(new) == stable(old)
    same_day = (old_meta.get("generated_at") or "")[:10] == today.strftime("%Y-%m-%d")
    if not (same and same_day):
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(new, f, ensure_ascii=False, indent=1)
            f.write("\n")
        print("Оновлено", args.out)
    else:
        print("Без змін")
    for w in warnings:
        print("УВАГА:", w)
    for e in errors:
        print("ПОМИЛКА:", e, file=sys.stderr)
    if errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
