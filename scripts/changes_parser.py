"""Парсер PDF замін ЗТК (файл на конкретну дату, усі курси разом).

Таблиця: Група | Пара | Дисципліна | Викладач | Аудиторія.
Підводні камені, які тут враховані:
  - пари записані римськими цифрами-символами Unicode (Ⅲ, Ⅳ ...);
  - у клітинці групи може бути список («Ф35,Е34», «Фк36, Фк36А»);
  - А20 і А20А — різні групи, тому порівнюємо точно, а не за префіксом;
  - латинські/кириличні літери у назвах груп змішуються — нормалізуємо.
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


def _row(groups_text, pair_text, subject, teacher, room, target, out):
    pair = _pair_no(pair_text)
    if pair is None:
        return
    if target not in split_groups(groups_text):
        return
    subject = _clean(subject)
    out.append({
        "pair": pair,
        "subject": subject,
        "teacher": _clean(teacher),
        "room": _clean(room),
        "cancelled": bool(CANCEL_RE.search(subject)),
    })


def parse_changes(pdf_path, group):
    """{'date': 'YYYY-MM-DD'|None, 'rows_total': int, 'changes': [...]}"""
    target = norm_group(group)
    changes, total, date = [], 0, None
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
            _row(g, p, subj, teach, room, target, changes)

        if total == 0:                    # запасний шлях: розбір рядків тексту
            prev = None
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
                _row(lm.group("groups"), lm.group("pair"), subj, teach, room, target, changes)

    return {"date": date, "rows_total": total, "changes": changes}


if __name__ == "__main__":
    import json
    print(json.dumps(
        parse_changes(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "А20"),
        ensure_ascii=False, indent=1,
    ))
