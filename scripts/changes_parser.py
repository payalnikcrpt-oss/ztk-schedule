"""Парсер PDF замін ЗТК (файл на конкретну дату, усі курси разом).

Таблиця: Група | Пара | Дисципліна | Викладач | Аудиторія.
Підводні камені, які тут враховані:
  - пари записані римськими цифрами-символами Unicode (Ⅲ, Ⅳ ...);
  - у клітинці групи може бути список («Ф35,Е34», «Фк36, Фк36А»);
  - А20 і А20А — різні групи, тому порівнюємо точно, а не за префіксом;
  - латинські/кириличні літери у назвах груп змішуються — нормалізуємо.

Дві точки входу:
  parse_changes(pdf, group)          - заміни однієї групи
  parse_changes_all(pdf, groups)     - заміни одразу для набору груп (PDF читається один раз)
"""
import re
import sys
from datetime import datetime

import pdfplumber

from common import ROMAN_TO_INT, norm_group, split_groups

DATE_RE = re.compile(r"(\d{2})\.(\d{2})\.(\d{4})")
LINE_RE = re.compile(
    r"^(?P<groups>.+?)\s+(?P<pair>[ⅠⅡⅢⅣⅤⅥ]|VI|IV|V|I{1,3}|[1-6])\s+(?P<rest>.+)$"
)
TEACHER_RE = re.compile(
    r"([А-ЯІЇЄҐ][а-яіїєґ'’\-]+\s+[А-ЯІЇЄҐ]\.\s?[А-ЯІЇЄҐ]\.?)\s*(.*)$"
)
CANCEL_RE = re.compile(r"скасов|відмін|не\s+проводит|пари\s+немає", re.IGNORECASE)


def _clean(s):
    return re.sub(r"\s+", " ", (s or "").replace("\n", " ")).strip()


def _pair_no(text):
    t = _clean(text)
    if t.isdigit():
        return int(t)
    return ROMAN_TO_INT.get(t)


def _make_entry(pair, subject, teacher, room):
    subject = _clean(subject)
    return {
        "pair": pair,
        "subject": subject,
        "teacher": _clean(teacher),
        "room": _clean(room),
        "cancelled": bool(CANCEL_RE.search(subject)),
    }


def _read_rows(pdf_path):
    """-> (date 'YYYY-MM-DD'|None, rows_total, rows)

    rows: [(текст_груп, текст_пари, предмет, викладач, аудиторія)], лише рядки з номером пари.
    """
    rows = []
    total, date = 0, None
    with pdfplumber.open(pdf_path) as pdf:
        full_text = ""
        table_rows = []
        for page in pdf.pages:
            full_text += (page.extract_text() or "") + "\n"
            for tb in page.extract_tables():
                table_rows.extend(tb)

        m = re.search(r"на\s+" + DATE_RE.pattern, full_text)
        m = m or DATE_RE.search(full_text)
        if m:
            d, mo, y = m.groups()[-3:]
            date = f"{y}-{mo}-{d}"

        prev_group = ""
        for r in table_rows:
            r = (r + [None] * 5)[:5]
            g, p, subj, teach, room = r
            if _pair_no(p) is None:      # шапка таблиці або службовий рядок
                continue
            if not _clean(g):
                g = prev_group
            prev_group = g
            total += 1
            rows.append((g, p, subj, teach, room))

        if total == 0:                    # запасний шлях: розбір рядків тексту
            for line in full_text.split("\n"):
                lm = LINE_RE.match(_clean(line))
                if not lm:
                    continue
                total += 1
                rest = lm.group("rest")
                room = ""
                rm = re.search(r"\s(\S+)$", rest)
                if rm:
                    room, rest = rm.group(1), rest[: rm.start()]
                subj, teach = rest, ""
                tm = None
                for cand in TEACHER_RE.finditer(rest):
                    tm = cand
                if tm:
                    subj, teach = rest[: tm.start()], tm.group(1)
                rows.append((lm.group("groups"), lm.group("pair"), subj, teach, room))
    return date, total, rows


def parse_changes(pdf_path, group):
    """{'date': 'YYYY-MM-DD'|None, 'rows_total': int, 'changes': [...]}"""
    target = norm_group(group)
    date, total, rows = _read_rows(pdf_path)
    changes = []
    for g, p, subj, teach, room in rows:
        pair = _pair_no(p)
        if pair is None or target not in split_groups(g):
            continue
        changes.append(_make_entry(pair, subj, teach, room))
    return {"date": date, "rows_total": total, "changes": changes}


def parse_changes_all(pdf_path, groups):
    """Заміни одразу для набору груп.

    -> {'date', 'rows_total', 'changes': {група: [...]}}; ключі лише з переліку groups
    (назви нормалізуються), група без замін має порожній список.
    """
    wanted = {norm_group(g) for g in groups}
    date, total, rows = _read_rows(pdf_path)
    out = {g: [] for g in wanted}
    for g, p, subj, teach, room in rows:
        pair = _pair_no(p)
        if pair is None:
            continue
        seen = set()
        for name in split_groups(g):
            if name in wanted and name not in seen:
                seen.add(name)
                out[name].append(_make_entry(pair, subj, teach, room))
    return {"date": date, "rows_total": total, "changes": out}


if __name__ == "__main__":
    import json
    print(json.dumps(
        parse_changes(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "А20"),
        ensure_ascii=False, indent=1,
    ))
