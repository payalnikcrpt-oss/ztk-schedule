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

// Заглушка SpreadsheetApp: лише те, що потрібно для збирання тексту клітинок тижня
const SpreadsheetApp = {
  newRichTextValue() {
    let text = '';
    const o = { setText(t) { text = t; return o; }, setTextStyle() { return o; }, build() { return { getText: () => text }; } };
    return o;
  },
  newTextStyle() {
    const o = { setBold() { return o; }, setForegroundColor() { return o; }, setFontSize() { return o; }, build() { return {}; } };
    return o;
  },
};

const __props = {};
const PropertiesService = { getDocumentProperties: () => ({
  getProperty: (k) => (k in __props ? __props[k] : null),
  setProperty: (k, v) => { __props[k] = v; },
}) };

const ctx = vm.createContext({ Utilities, SpreadsheetApp, PropertiesService, console, Object, JSON, Math, parseInt, String, Date });
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

const weekOf = (iso) => {
  ctx.__d = new Date(iso + 'T12:00:00+03:00'); ctx.__tz = TZ;
  ctx.__t = run('partsFor_(__d, __tz)');
  return run('weekDays_(__t, __tz)');
};

t('Тиждень: у будні це Пн-Пт цього тижня, у вихідні наступного', () => {
  assert.deepStrictEqual(Array.from(weekOf('2026-10-14').map(p => p.display)),
    ['12.10.2026', '13.10.2026', '14.10.2026', '15.10.2026', '16.10.2026']);
  assert.strictEqual(weekOf('2026-10-12')[0].display, '12.10.2026');
  assert.strictEqual(weekOf('2026-10-16')[0].display, '12.10.2026');
  assert.strictEqual(weekOf('2026-10-10')[0].display, '12.10.2026'); // субота
  assert.strictEqual(weekOf('2026-10-11')[0].display, '12.10.2026'); // неділя
});

t('Тиждень: сітка без ЧОТ/НЕ ЧОТ, пари за реальними датами', () => {
  ctx.__days = weekOf('2026-10-07');            // тиждень 05.10-09.10
  const w = run('buildWeekGrid_(__data, __bells, __days)');
  assert.strictEqual(w.rich.length, 4);
  w.rich.forEach(r => assert.strictEqual(r.length, 6));
  const cell = (r, c) => w.rich[r][c].getText();
  w.rich.forEach(r => r.forEach(c => assert.ok(!/ЧОТ/.test(c.getText()))));
  assert.ok(cell(0, 0).includes('1 пара') && cell(0, 0).includes('08:00') && cell(0, 0).includes('09:20'));
  // Пн 05.10 (НЕ ЧОТ): 1 пари немає
  assert.strictEqual(cell(0, 1), '—'); assert.strictEqual(w.h[0][1], 'center');
  // Чт 08.10 (ЧОТ): 3 пара Електротехніка
  assert.ok(cell(2, 4).startsWith('Електротехніка'));
  // Пт, 4 пара: порожньо
  assert.strictEqual(cell(3, 5), '—');
  // звичайні пари на сірому тлі
  assert.strictEqual(w.bg[2][4], '#f3f4f6');
});

t('Тиждень: інший тиждень дає іншу парність (Чт 15.10 = Електроніка)', () => {
  ctx.__days = weekOf('2026-10-14');            // тиждень 12.10-16.10
  const w = run('buildWeekGrid_(__data, __bells, __days)');
  assert.ok(w.rich[2][4].getText().startsWith('Електроніка'));
});

t('Тиждень: заміна підсвічується, скасована теж', () => {
  const d2 = JSON.parse(JSON.stringify(data));
  d2.changes['2026-10-06'] = [{ pair: 2, subject: 'Нова пара', teacher: 'Т.Т.', room: '5', cancelled: false },
                              { pair: 3, subject: 'скасовано', teacher: '', room: '', cancelled: true }];
  ctx.__d2 = d2; ctx.__days = weekOf('2026-10-07');
  const w = run('buildWeekGrid_(__d2, __bells, __days)');
  assert.ok(w.rich[1][2].getText().startsWith('Нова пара'));
  assert.strictEqual(w.bg[1][2], '#fde68a'); assert.strictEqual(w.bg[2][2], '#fde68a');
});

t('Налаштування: службові рядки сховані, статус показується лише при проблемі', () => {
  const calls = [];
  const sh = { showRows: (r, n) => calls.push(['show', r, n || 1]), hideRows: (r, n) => calls.push(['hide', r, n || 1]) };
  ctx.__sh = sh;
  run('applySettingsVisibility_(__sh, false, false)');
  assert.deepStrictEqual(calls, [['hide', 3, 1], ['hide', 5, 1], ['hide', 6, 1], ['hide', 7, 1], ['hide', 8, 7]]);
  calls.length = 0;
  run('applySettingsVisibility_(__sh, true, true)');
  assert.deepStrictEqual(calls.slice(0, 4), [['show', 3, 1], ['hide', 5, 1], ['hide', 6, 1], ['show', 7, 1]]);
  calls.length = 0;
  __props.showAdvanced = '1';                    // «Показати службові налаштування»
  run('applySettingsVisibility_(__sh, false, false)');
  assert.strictEqual(calls.length, 0);
  delete __props.showAdvanced;
});

t('Групи: старий файл (одна група) і вибір з різним написанням', () => {
  const names = run('listGroups_(__data)');
  assert.deepStrictEqual(Array.from(names), ['А20']);
  ctx.__names = names; ctx.__w = 'A20';   // латинська A
  const g = run('pickGroup_(__data, __names, __w)');
  assert.strictEqual(g.name, 'А20'); assert.strictEqual(g.note, '');
  assert.ok(g.schedule['1']);
});

t('Групи: файл з кількома групами, сортування, вибір і невідома група', () => {
  const multi = { groups: {
    'МТ22А': { schedule: { '1': {} }, changes: { '2026-10-12': [] } },
    'А20': { schedule: data.schedule, changes: data.changes },
    'ЕЛ21': { schedule: {}, changes: {} },
  } };
  ctx.__multi = multi;
  const names = run('listGroups_(__multi)');
  assert.deepStrictEqual(Array.from(names), ['А20', 'ЕЛ21', 'МТ22А']);
  ctx.__names = names; ctx.__w = 'мт22а';
  const g = run('pickGroup_(__multi, __names, __w)');
  assert.strictEqual(g.name, 'МТ22А'); assert.deepStrictEqual(Object.keys(g.schedule), ['1']);
  ctx.__w = 'Я99';
  const bad = run('pickGroup_(__multi, __names, __w)');
  assert.strictEqual(bad.name, 'А20'); assert.ok(bad.note.includes('Я99'));
});

t('Групи: розклад дня береться саме з вибраної групи', () => {
  const multi = { groups: {
    'А20': { schedule: data.schedule, changes: {} },
    'МТ22А': { schedule: { '1': { '1': { mode: 'always', entry: { subject: 'Тестовий предмет', teacher: 'Т.Т.', room: '1' } } } }, changes: {} },
  } };
  ctx.__multi = multi; ctx.__names = run('listGroups_(__multi)'); ctx.__w = 'МТ22А';
  const g = run('pickGroup_(__multi, __names, __w)');
  ctx.__g = g; ctx.__d = new Date('2026-10-05T12:00:00+03:00'); ctx.__tz = TZ;
  ctx.__p = run('partsFor_(__d, __tz)');
  const r = run('resolveDay_(__g, __p, __bells)');
  assert.strictEqual(subj(r, 1), 'Тестовий предмет');
});

console.log(`\nУсього пройшло: ${n}`);
