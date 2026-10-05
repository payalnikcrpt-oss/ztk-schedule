"""Тести парсерів на справжніх PDF із tests/fixtures.  Запуск: python -m unittest discover -s tests"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))

from changes_parser import parse_changes            # noqa: E402
from common import norm_group, split_groups          # noqa: E402
from schedule_parser import ParseError, parse_main_schedule  # noqa: E402

MAIN = os.path.join(HERE, "fixtures", "schedule_2_course.pdf")
CHG = os.path.join(HERE, "fixtures", "changes_06.10.2026.pdf")


def S(subject, teacher, room):
    return {"subject": subject, "teacher": teacher, "room": room}


class TestMain(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.res = parse_main_schedule(MAIN, "А20")
        cls.s = cls.res["schedule"]

    def test_no_warnings(self):
        self.assertEqual(self.res["warnings"], [])

    def test_always_pair(self):
        self.assertEqual(self.s["1"]["4"], {"mode": "always", "entry": S(
            "Електроніка, мікроелектроніка і схемотехніка", "Кузьомко В.І.", "208")})

    def test_even_only(self):
        slot = self.s["1"]["1"]
        self.assertEqual(slot["mode"], "split")
        self.assertEqual(slot["even"], S("Українська література", "Степанчук Н.В.", "208"))
        self.assertIsNone(slot["odd"])

    def test_odd_only_without_room(self):
        slot = self.s["2"]["4"]
        self.assertIsNone(slot["even"])
        self.assertEqual(slot["odd"], S("Історія України", "Міщенко В.А.", ""))

    def test_both_halves(self):
        slot = self.s["4"]["3"]
        self.assertEqual(slot["even"]["teacher"], "Пегарькова Г.А.")
        self.assertEqual(slot["odd"]["teacher"], "Кузьомко В.І.")
        self.assertEqual(slot["even"]["room"], "208")
        self.assertEqual(slot["odd"]["room"], "208")

    def test_gym_room(self):
        self.assertEqual(self.s["3"]["1"]["even"]["room"], "сп.з.")
        self.assertEqual(self.s["5"]["2"]["entry"]["room"], "сп.з.")

    def test_empty_cells(self):
        self.assertIsNone(self.s["5"]["4"])
        for d in "12345":
            self.assertIsNone(self.s[d]["5"])

    def test_group_exact_not_prefix(self):
        a = parse_main_schedule(MAIN, "А20А")["schedule"]
        self.assertNotEqual(a, self.s)  # А20А — окрема колонка

    def test_latin_letters_in_group(self):
        self.assertEqual(parse_main_schedule(MAIN, "A20")["schedule"], self.s)  # лат. A

    def test_other_group_parses(self):
        r = parse_main_schedule(MAIN, "ЕЛ21")
        self.assertEqual(r["warnings"], [])

    def test_unknown_group(self):
        with self.assertRaises(ParseError):
            parse_main_schedule(MAIN, "Я99")


class TestChanges(unittest.TestCase):
    def test_date_and_rows(self):
        r = parse_changes(CHG, "А20")
        self.assertEqual(r["date"], "2026-10-06")
        self.assertEqual(r["rows_total"], 10)
        self.assertEqual(r["changes"], [])

    def test_group_list_cell(self):
        for g in ("Ф35", "Е34", "E34"):
            self.assertEqual([c["pair"] for c in parse_changes(CHG, g)["changes"]], [3, 4])

    def test_roman_pair_numbers(self):
        self.assertEqual([c["pair"] for c in parse_changes(CHG, "Д49")["changes"]], [4, 6])

    def test_fields(self):
        c = parse_changes(CHG, "Мт42")["changes"][0]
        self.assertEqual((c["pair"], c["subject"], c["room"]), (4, "Основи національного спротиву", "108"))

    def test_second_group_in_comma_list(self):
        self.assertEqual(len(parse_changes(CHG, "Фк36А")["changes"]), 1)


class TestCommon(unittest.TestCase):
    def test_norm(self):
        self.assertEqual(norm_group(" a20 "), "А20")
        self.assertNotEqual(norm_group("А20А"), norm_group("А20"))
        self.assertEqual(split_groups("Фк36, Фк36А"), ["ФК36", "ФК36А"])


if __name__ == "__main__":
    unittest.main()
