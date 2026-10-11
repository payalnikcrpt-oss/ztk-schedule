"""Збирає data/a20.json з сайту ЗТК: розклад і заміни ВСІХ груп.

Файл називається a20.json лише щоб не ламати вже вставлене посилання в таблиці.
Усередині: розділ "groups" з усіма групами (їх список потрапляє у випадаючий список таблиці)
і для сумісності зі старим скриптом "schedule"/"changes" групи за замовчуванням (config.json, "group").

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
from changes_parser import parse_changes_all      # noqa: E402
from common import norm_group                     # noqa: E402
from schedule_parser import ParseError, parse_all_groups  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATE_RE = re.compile(r"\b(\d{2})\.(\d{2})\.(\d{4})\b")
MAIN_RE = re.compile(r"розклад.*?(?<!\d)(\d)\s*курс", re.IGNORECASE)


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
    """({курс: url PDF розкладу}, {дата: url заміни}) зі сторінки сайту.

    Беруться всі посилання «Розклад … N курс». Якщо в config.json є "courses": [2, 3],
    лише ці курси.
    """
    from bs4 import BeautifulSoup
    html = http_get(cfg["page_url"], cfg)
    soup = BeautifulSoup(html, "html.parser")
    only = {str(c) for c in cfg["courses"]} if cfg.get("courses") else None
    mains, changes = {}, {}
    for a in soup.find_all("a", href=True):
        text = " ".join(a.get_text(" ").split())
        href = urljoin(cfg["page_url"], a["href"])
        m = DATE_RE.search(text) or DATE_RE.search(unquote(href))
        if m:
            d, mo, y = m.groups()
            changes[f"{y}-{mo}-{d}"] = href
            continue
        mm = MAIN_RE.search(text)
        if mm:
            course = mm.group(1)
            if (only is None or course in only) and course not in mains:
                mains[course] = href
    return mains, changes


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
    meta = d.get("meta", {})
    meta.pop("generated_at", None)
    meta.pop("main_checked_at", None)
    for s in (meta.get("sources") or {}).values():
        s.pop("checked_at", None)
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
    today_s = today.strftime("%Y-%m-%d")
    default_group = norm_group(cfg["group"])
    primary = str(cfg["course"])
    old = load_json(args.out, {}) or {}
    old_meta = old.get("meta", {})
    old_groups = old.get("groups") or {}
    old_sources = old_meta.get("sources") or {}
    warnings, errors = [], []
    offline = bool(args.main_pdf or args.changes_pdf)

    groups = {}    # назва групи -> розклад
    sources = {}   # курс -> {url, sha256, checked_at, groups}
    page_changes = {}

    def reuse(course, prev):
        """Беремо групи курсу з попереднього файлу (PDF не змінився або сайт тимчасово недоступний)."""
        for g in prev.get("groups") or []:
            if g in old_groups and g not in groups:
                groups[g] = old_groups[g].get("schedule")
        sources[course] = prev

    def can_reuse(prev):
        gs = prev.get("groups") or []
        return bool(gs) and all(g in old_groups for g in gs)

    def add_groups(course, res, url, sha):
        for g, sched in res["groups"].items():
            if g in groups:
                warnings.append(f"{g}: група є в PDF кількох курсів, залишено першу")
                continue
            groups[g] = sched
        warnings.extend(f"Розклад {course} курсу, {w}" for w in res["warnings"])
        sources[course] = {
            "url": url, "sha256": sha,
            "checked_at": now.isoformat(timespec="seconds"),
            "groups": sorted(res["groups"]),
        }

    # ---------- основний розклад (усі курси, усі групи) ----------
    if args.main_pdf:
        try:
            res = parse_all_groups(args.main_pdf)
            add_groups(primary, res, args.main_pdf, None)
        except Exception as e:
            errors.append(f"Основний розклад: {e}")
    elif not offline:
        try:
            mains, page_changes = find_links(cfg)
        except Exception as e:
            mains = {}
            errors.append(f"Сторінка розкладів: {e}")
        if primary not in mains:
            fb = cfg.get("main_pdf_fallback_url") or (old_sources.get(primary) or {}).get("url")
            if fb:
                mains[primary] = fb
        if primary not in mains:
            errors.append(f"Основний розклад: не знайшов посилання на розклад {primary} курсу")

        for course, link in sorted(mains.items()):
            prev = old_sources.get(course) or {}
            try:
                fresh = False
                if prev.get("checked_at") and link == prev.get("url") and can_reuse(prev):
                    age = now - datetime.fromisoformat(prev["checked_at"])
                    fresh = age < timedelta(hours=cfg["main_recheck_hours"])
                if fresh:
                    reuse(course, prev)
                    continue
                path, sha = download_pdf(link, cfg)
                try:
                    if sha == prev.get("sha256") and link == prev.get("url") and can_reuse(prev):
                        reuse(course, dict(prev, checked_at=now.isoformat(timespec="seconds")))
                    else:
                        add_groups(course, parse_all_groups(path), link, sha)
                finally:
                    os.remove(path)
            except Exception as e:
                msg = f"Розклад {course} курсу: {e}"
                (errors if course == primary else warnings).append(msg)
                if can_reuse(prev):          # лишаємо попередні дані цього курсу
                    reuse(course, prev)
    else:
        # лише --changes-pdf: розклад беремо з попереднього файлу
        for course, prev in old_sources.items():
            if can_reuse(prev):
                reuse(course, prev)

    if not groups:
        # ні свіжого, ні попереднього розкладу
        print("ПОМИЛКА: немає розкладу.", *errors, sep="\n  ", file=sys.stderr)
        sys.exit(1)

    if default_group not in groups:
        errors.append(f"Групу {default_group} з config.json не знайдено серед розібраних груп")

    # ---------- заміни (одразу для всіх груп) ----------
    changes = {
        g: {k: v for k, v in ((old_groups.get(g) or {}).get("changes") or {}).items() if k >= today_s}
        for g in groups
    }

    def put_changes(date, parsed):
        for g in groups:
            changes[g][date] = parsed["changes"].get(g, [])

    try:
        if args.changes_pdf:
            for p in args.changes_pdf:
                r = parse_changes_all(p, groups)
                if r["date"]:
                    put_changes(r["date"], r)
        elif not offline:
            urls = {k: v for k, v in page_changes.items() if k >= today_s}
            urls.update(probe_changes(cfg, today, urls))
            for key, url in sorted(urls.items()):
                try:
                    path, _ = download_pdf(url, cfg)
                    try:
                        r = parse_changes_all(path, groups)
                    finally:
                        os.remove(path)
                    if r["rows_total"] == 0:
                        warnings.append(f"Заміни {key}: у PDF не знайдено жодного рядка таблиці")
                    put_changes(r["date"] or key, r)
                except Exception as e:
                    errors.append(f"Заміни {key}: {e}")
    except Exception as e:
        errors.append(f"Заміни: {e}")

    all_dates = sorted({d for g in changes.values() for d in g})
    main_src = sources.get(primary) or {}
    default_changes = dict(sorted((changes.get(default_group) or {}).items()))

    new = {
        "meta": {
            "group": default_group,
            "generated_at": now.isoformat(timespec="seconds"),
            "main_pdf_url": main_src.get("url"),
            "main_pdf_sha256": main_src.get("sha256"),
            "main_checked_at": main_src.get("checked_at"),
            "sources": {k: sources[k] for k in sorted(sources)},
            "changes_dates": all_dates,
            "warnings": warnings,
            "errors": errors,
        },
        # для сумісності зі старим скриптом таблиці: група за замовчуванням
        "schedule": groups.get(default_group, {}),
        "changes": default_changes,
        "groups": {
            g: {"schedule": groups[g], "changes": dict(sorted(changes[g].items()))}
            for g in sorted(groups)
        },
    }

    # пишемо, лише якщо щось змінилось або минула доба (heartbeat для Actions)
    same = stable(new) == stable(old)
    same_day = (old_meta.get("generated_at") or "")[:10] == today_s
    if not (same and same_day):
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(new, f, ensure_ascii=False, indent=1)
            f.write("\n")
        print("Оновлено", args.out, f"(груп: {len(groups)})")
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
