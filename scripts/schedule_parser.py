"""Парсер основного PDF розкладу ЗТК.

Працює за координатами клітинок, а не за «сирим» текстом, тому не залежить від
порядку тексту в PDF. Колонка групи знаходиться за заголовком (А20), нічого
про предмети, викладачів чи аудиторії в коді не зашито.

Структура PDF (перевірена на розкладі 2 курсу 2026-2027):
  - групи йдуть колонками, кожна: [№ пари][предмет | викладач][аудиторія]
  - 5 днів (Пн-Пт) блоками зверху вниз, у кожному 5 рядків-пар
  - рядок може бути розділений навпіл: верхня половина = ЧОТ, нижня = НЕ ЧОТ
"""
import re
import sys
from collections import Counter, defaultdict

import pdfplumber

from common import norm_group

HEADER_RE = re.compile(r"^[A-Za-zА-ЯІЇЄҐа-яіїєґ]{1,4}\d{2}[A-Za-zА-ЯІЇЄҐ]?$")
DAYS = ["ПОНЕДІЛОК", "ВІВТОРОК", "СЕРЕДА", "ЧЕТВЕР", "П'ЯТНИЦЯ"]
PAIRS_PER_DAY = 5


class ParseError(Exception):
    pass


def _find_group_headers(page):
    """{нормалізована назва групи: центр по x}."""
    by_top = defaultdict(list)
    for c in page.chars:
        if c["top"] < 40 and c["text"].strip():
            by_top[round(c["top"])].append(c)
    found = {}
    for chars in by_top.values():
        chars.sort(key=lambda c: c["x0"])
        cluster = []

        def flush():
            if not cluster:
                return
            text = "".join(c["text"] for c in cluster)
            if HEADER_RE.match(text):
                cx = (cluster[0]["x0"] + cluster[-1]["x1"]) / 2
                found[norm_group(text)] = cx

        for c in chars:
            if cluster and c["x0"] - cluster[-1]["x1"] > 2.5:
                flush()
                cluster = []
            cluster.append(c)
        flush()
    return found


def _text(chars):
    """Збирає текст клітинки: рядки зверху вниз, символи зліва направо."""
    if not chars:
        return ""
    lines = []
    for c in sorted(chars, key=lambda c: ((c["top"] + c["bottom"]) / 2, c["x0"])):
        cy = (c["top"] + c["bottom"]) / 2
        if lines and abs(cy - lines[-1][0]) <= 1.3:
            lines[-1][1].append(c)
        else:
            lines.append([cy, [c]])
    out = []
    for _, cs in lines:
        out.append("".join(c["text"] for c in sorted(cs, key=lambda c: c["x0"])))
    return re.sub(r"\s+", " ", " ".join(out)).strip()


def _group_geometry(page, cx):
    thin_h = [r for r in page.rects if (r["bottom"] - r["top"]) < 0.6 and r["top"] > 30]
    blocks = Counter(
        (round(r["x0"], 1), round(r["x1"], 1))
        for r in thin_h
        if r["x0"] <= cx <= r["x1"] and 25 <= (r["x1"] - r["x0"]) <= 60
    )
    if not blocks:
        raise ParseError("Не знайдено клітинки під заголовком групи")
    (bx0, bx1), _ = blocks.most_common(1)[0]

    aud = None
    for r in thin_h:
        if abs(r["x0"] - (bx1 + 0.2)) < 0.6 and (r["x1"] - r["x0"]) < 8:
            aud = (r["x0"], r["x1"])
            break
    if aud is None:
        aud = (bx1, bx1 + 3.7)

    # роздільник «предмет | викладач» — тонкий вертикальний прямокутник
    dividers = [
        r for r in page.rects
        if (r["x1"] - r["x0"]) < 0.6 and (r["bottom"] - r["top"]) > 30
        and bx0 + 3 < r["x0"] < bx1 - 3
    ]
    if not dividers:
        raise ParseError("Не знайдено межу предмет/викладач")
    div_x = Counter(round(r["x0"], 1) for r in dividers).most_common(1)[0][0]
    days = sorted(
        [(r["top"], r["bottom"]) for r in dividers if abs(r["x0"] - div_x) < 0.3]
    )
    if len(days) != 5:
        raise ParseError(f"Очікував 5 днів, знайшов {len(days)}")
    mids = sorted(
        r["top"] for r in thin_h
        if abs(r["x0"] - bx0) < 0.4 and abs(r["x1"] - bx1) < 0.4
    )
    return {"bx0": bx0, "bx1": bx1, "div": div_x, "aud": aud, "days": days, "hlines": mids}


def _entry(subject, teacher, room):
    if not subject and not teacher:
        return None
    return {"subject": subject, "teacher": teacher, "room": room}


def parse_main_schedule(pdf_path, group):
    """Повертає {'group','schedule': {'1'..'5': {'1'..'5': slot}}, 'warnings': [...]}.

    slot: None | {'mode':'always','entry':E} | {'mode':'split','even':E|None,'odd':E|None}
    E = {'subject','teacher','room'}.  even = ЧОТ (верхня половина), odd = НЕ ЧОТ.
    """
    target = norm_group(group)
    warnings = []
    with pdfplumber.open(pdf_path) as pdf:
        page = pdf.pages[0]
        headers = _find_group_headers(page)
        if target not in headers:
            raise ParseError(
                f"Групу {target} не знайдено в заголовках PDF. Знайдені: {', '.join(sorted(headers))}"
            )
        g = _group_geometry(page, headers[target])
        chars = [c for c in page.chars if c["text"] != "" ]

        def in_x(c, x0, x1):
            cx = (c["x0"] + c["x1"]) / 2
            return x0 <= cx < x1

        schedule = {}
        for d, (dt, db) in enumerate(g["days"], start=1):
            rh = (db - dt) / PAIRS_PER_DAY
            schedule[str(d)] = {}
            for k in range(PAIRS_PER_DAY):
                rt, rb = dt + rh * k, dt + rh * (k + 1)
                mid = [y for y in g["hlines"] if rt + 1.5 < y < rb - 1.5]
                halves = [(rt, rb)] if not mid else [(rt, mid[0]), (mid[0], rb)]

                def cell(a, b, x0, x1):
                    return _text([
                        c for c in chars
                        if in_x(c, x0, x1) and a <= (c["top"] + c["bottom"]) / 2 < b
                    ])

                subj = [cell(a, b, g["bx0"], g["div"]) for a, b in halves]
                teach = [cell(a, b, g["div"], g["bx1"] + 0.1) for a, b in halves]
                aud_row = [cell(a, b, g["aud"][0], g["aud"][1] + 0.1) for a, b in halves]

                for i in range(len(halves)):
                    if bool(subj[i]) != bool(teach[i]):
                        warnings.append(
                            f"{DAYS[d-1]} пара {k+1}: у клітинці лише предмет або лише викладач"
                        )

                has = [bool(subj[i] or teach[i]) for i in range(len(halves))]
                rooms_present = [r for r in aud_row if r]

                def room_for(i):
                    if len(halves) == 1:
                        return aud_row[0]
                    if sum(has) == 2 and len(rooms_present) == 2:
                        return aud_row[i]
                    return rooms_present[0] if rooms_present else ""

                entries = [
                    _entry(subj[i], teach[i], room_for(i)) if has[i] else None
                    for i in range(len(halves))
                ]

                if len(halves) == 1:
                    slot = {"mode": "always", "entry": entries[0]} if entries[0] else None
                else:
                    up, low = entries
                    if up and low and up == low:
                        slot = {"mode": "always", "entry": up}
                    elif up or low:
                        slot = {"mode": "split", "even": up, "odd": low}
                    else:
                        slot = None
                schedule[str(d)][str(k + 1)] = slot

    return {"group": target, "schedule": schedule, "warnings": warnings}


if __name__ == "__main__":
    import json
    res = parse_main_schedule(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "А20")
    print(json.dumps(res, ensure_ascii=False, indent=1))
