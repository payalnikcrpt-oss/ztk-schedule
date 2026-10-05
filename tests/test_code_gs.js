// Перевірка логіки Code.gs у Node: ЧОТ/НЕ ЧОТ, заміни, вихідні, перехід 31 -> 1.
// Запуск: node tests/test_code_gs.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const code = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');

// Заглушка Utilities на основі Intl
const Utilities = {
  formatDate(date, tz, fmt) {
    const p = {};
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
    }).formatToParts(date).forEach(x => { p[x.type] = x.value; });
    const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday];
    switch (fmt) {
      case 'yyyy-MM-dd': return `${p.year}-${p.month}-${p.day}`;
      case 'u': return String(wd);
      case 'd': return String(parseInt(p.day, 10));
      case 'dd.MM.yyyy': return `${p.day}.${p.month}.${p.year}`;
      case 'HH:mm': return `${p.hour}:${p.minute}`;
      default: throw new Error('fmt ' + fmt);
    }
  },
  parseDate(str, tz, fmt) {
    // 'yyyy-MM-dd HH:mm' у заданому поясі -> Date (підбір зміщення)
    const [d, t] = str.split(' ');
    const guess = new Date(`${d}T${t}:00Z`);
    const shown = Utilities.formatDate(guess, tz, 'yyyy-MM-dd') + ' ' + Utilities.formatDate(guess, tz, 'HH:mm');
    const diff = new Date(shown.replace(' ', 'T') + ':00Z') - guess;
    return new Date(guess.getTime() - diff);
  },
};

const ctx = vm.createContext({ Utilities, console, Object, JSON, Math, parseInt, String, Date });
vm.runInContext(code, ctx);
const run = (src) => vm.runInContext(src, ctx);

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'a20_expected.json'), 'utf8'));
const bells = { 1: { start: '08:00', end: '09:20' }, 2: { start: '09:30', end: '10:50' },
  3: { start: '11:20', end: '12:40' }, 4: { start: '12:50', end: '14:10' } };
ctx.__data = data; ctx.__bells = bells;
const TZ = 'Europe/Kyiv';
const day = (iso) => {
  ctx.__d = new Date(iso + 'T12:00:00+03:00'); ctx.__tz = TZ;
  const p = run('partsFor_(__d, __tz)'); ctx.__p = p;
  return { p, r: run('resolveDay_(__data, __p, __bells)') };
};
const subj = (r, n) => r.rows[n - 1].subject;

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ', name); };

t('05.10.2026 (Пн, 5 = НЕ ЧОТ): 1 пари немає, далі математика', () => {
  const { p, r } = day('2026-10-05');
  assert.strictEqual(p.dow, 1); assert.strictEqual(p.parityLabel, 'НЕ ЧОТ');
  assert.strictEqual(subj(r, 1), 'Немає пари');
  assert.strictEqual(r.rows[0].teacher, '—'); assert.strictEqual(r.rows[0].room, '—');
  assert.ok(subj(r, 2).startsWith('Математика'));
  assert.strictEqual(r.rows[3].teacher, 'Кузьомко В.І.');
  assert.strictEqual(r.rows[0].time, '08:00–09:20');
  assert.strictEqual(r.status, 'Немає замін');
});

t('06.10.2026 (Вт, 6 = ЧОТ): 4 пари немає (вона лише НЕ ЧОТ)', () => {
  const { p, r } = day('2026-10-06');
  assert.strictEqual(p.parityLabel, 'ЧОТ');
  assert.strictEqual(subj(r, 4), 'Немає пари');
  assert.strictEqual(subj(r, 3), 'Соціологія');
});

t('07.10.2026 (Ср, 7 = НЕ ЧОТ): фізкультури (лише ЧОТ) немає', () => {
  assert.strictEqual(subj(day('2026-10-07').r, 1), 'Немає пари');
});

t('14.10.2026 (Ср, 14 = ЧОТ): фізкультура, аудиторія сп.з.', () => {
  const { r } = day('2026-10-14');
  assert.strictEqual(subj(r, 1), 'Фізична культура'); assert.strictEqual(r.rows[0].room, 'сп.з.');
});

t('08.10.2026 (Чт, 8 = ЧОТ): 3 пара Електротехніка', () => {
  assert.ok(subj(day('2026-10-08').r, 3).startsWith('Електротехніка'));
});

t('15.10.2026 (Чт, 15 = НЕ ЧОТ): 3 пара Електроніка', () => {
  const { r } = day('2026-10-15');
  assert.ok(subj(r, 3).startsWith('Електроніка')); assert.strictEqual(r.rows[2].teacher, 'Кузьомко В.І.');
});

t('13.10.2026 (Вт, 13 = НЕ ЧОТ): Історія України без аудиторії -> «—»', () => {
  const { r } = day('2026-10-13');
  assert.strictEqual(subj(r, 4), 'Історія України'); assert.strictEqual(r.rows[3].room, '—');
});

t('П\'ятниця: 4 пари немає', () => {
  assert.strictEqual(subj(day('2026-10-09').r, 4), 'Немає пари');
});

t('Субота: вихідний, усі пари «Немає пари»', () => {
  const { r } = day('2026-10-10');
  assert.ok(r.status.startsWith('Вихідний'));
  r.rows.forEach(x => { assert.strictEqual(x.subject, 'Немає пари'); assert.strictEqual(x.room, '—'); });
});

t('31 -> 1: обидва дні НЕ ЧОТ (за числом місяця)', () => {
  assert.strictEqual(day('2026-12-31').p.parityLabel, 'НЕ ЧОТ');
  assert.strictEqual(day('2027-01-01').p.parityLabel, 'НЕ ЧОТ');
});

t('Заміна замінює звичайну пару і не дублює її', () => {
  const d2 = JSON.parse(JSON.stringify(data));
  d2.changes['2026-10-06'] = [{ pair: 3, subject: 'Основи національного спротиву', teacher: 'Черкас В.М.', room: '305', cancelled: false }];
  ctx.__data = d2;
  const { r } = day('2026-10-06');
  assert.strictEqual(subj(r, 3), 'Основи національного спротиву');
  assert.strictEqual(r.rows[2].note, 'ЗАМІНА'); assert.strictEqual(r.rows[2].room, '305');
  assert.strictEqual(r.rows.filter(x => x.pair === 3).length, 1);
  assert.strictEqual(r.status, 'Заміни: 1');
  ctx.__data = data;
});

t('Заміна на порожню пару (4 пари у вівторок, ЧОТ) з\'являється', () => {
  const d2 = JSON.parse(JSON.stringify(data));
  d2.changes['2026-10-06'] = [{ pair: 4, subject: 'Рисунок', teacher: 'Кулик В. Г.', room: '412', cancelled: false }];
  ctx.__data = d2;
  const { r } = day('2026-10-06');
  assert.strictEqual(subj(r, 4), 'Рисунок'); assert.strictEqual(r.rows[3].note, 'ЗАМІНА');
  ctx.__data = data;
});

t('Скасована пара', () => {
  const d2 = JSON.parse(JSON.stringify(data));
  d2.changes['2026-10-06'] = [{ pair: 2, subject: 'Пару скасовано', teacher: '', room: '', cancelled: true }];
  ctx.__data = d2;
  const { r } = day('2026-10-06');
  assert.strictEqual(subj(r, 2), 'Пару скасовано'); assert.strictEqual(r.rows[1].kind, 'cancelled');
  ctx.__data = data;
});

t('Заміна на 5 пару не ламає таблицю, а потрапляє у статус', () => {
  const d2 = JSON.parse(JSON.stringify(data));
  d2.changes['2026-10-06'] = [{ pair: 5, subject: 'Рисунок', teacher: 'X', room: '1', cancelled: false }];
  ctx.__data = d2;
  const { r } = day('2026-10-06');
  assert.strictEqual(r.rows.length, 4); assert.ok(r.status.includes('5 пара'));
  ctx.__data = data;
});

t('Тиждень: ЧОТ зверху, НЕ ЧОТ знизу, порожні клітинки залишаються порожніми', () => {
  const w = run('buildWeekRows_(__data, __bells)');
  assert.strictEqual(w.rows.length, 5 * 4 * 2);
  const mon1 = w.rows[0], mon1b = w.rows[1];
  assert.strictEqual(mon1.label, 'ЧОТ'); assert.strictEqual(mon1.subject, 'Українська література');
  assert.strictEqual(mon1b.label, 'НЕ ЧОТ'); assert.strictEqual(mon1b.subject, '');
  const thu3 = w.rows[(3 * 4 + 2) * 2];
  assert.ok(thu3.subject.startsWith('Електротехніка')); assert.strictEqual(thu3.label, 'ЧОТ');
  assert.ok(w.rows[(3 * 4 + 2) * 2 + 1].subject.startsWith('Електроніка'));
  const fri4 = w.rows[(4 * 4 + 3) * 2];
  assert.strictEqual(fri4.subject, ''); assert.strictEqual(fri4.label, '');
});

console.log(`\nУсього пройшло: ${n}`);
