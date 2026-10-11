/**
 * Розклад ЗТК для Google Sheets.
 *
 * Скрипт НЕ містить жодного предмета, викладача чи аудиторії: усе приходить із
 * JSON-файлу, який GitHub Actions автоматично збирає з PDF на сайті ЗТК.
 *
 * Група вибирається на аркуші «Налаштування» (клітинка B4) з випадаючого списку.
 * Список груп береться з файлу даних.
 *
 * Підтримуються два формати файлу даних:
 *   1) старий, одна група:  { meta: {group, ...}, schedule: {...}, changes: {...} }
 *   2) новий, багато груп:  { meta: {...}, groups: { "А20": { schedule, changes }, "МТ22а": {...} } }
 *
 * Перший запуск: виберіть функцію setup() і натисніть «Виконати».
 * Після оновлення скрипта один раз запустіть в меню «Розклад → Увімкнути автооновлення»,
 * щоб зміна групи оновлювала таблицю одразу.
 */

const SHEET_TODAY = 'Сьогодні';
const SHEET_TOMORROW = 'Завтра';
const SHEET_WEEK = 'Поточний розклад';
const SHEET_SETTINGS = 'Налаштування';

const MAX_PAIRS = 4; // п'ятої пари немає
const DAY_NAMES = ['', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота', 'Неділя'];
const DEFAULT_BELLS = [['1', '08:00', '09:20'], ['2', '09:30', '10:50'], ['3', '11:20', '12:40'], ['4', '12:50', '14:10']];
const STALE_HOURS = 72;
const DEFAULT_GROUP = 'А20'; // кирилична «А»

// клітинки на аркуші «Налаштування»
const CELL_URL = 'B3';
const CELL_GROUP = 'B4';
const CELL_TZ = 'B5';
const CELL_UPDATED = 'B6';
const CELL_STATUS = 'B7';
const BELLS_FIRST_ROW = 11; // A11:C14

const STYLE_VER = 'navy-v2';
const WEEK_LAYOUT = 'grid-v2';
const OK_STATUS = 'Усе гаразд';

/* ============================ Меню і запуск ============================ */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Розклад')
    .addItem('Оновити зараз', 'refreshAll')
    .addItem('Оформити таблицю', 'styleAll')
    .addItem('Увімкнути автооновлення', 'installTriggers')
    .addSeparator()
    .addItem('Показати службові налаштування', 'showAdvanced')
    .addItem('Сховати службові налаштування', 'hideAdvanced')
    .addToUi();
}

/** Службові рядки «Налаштувань» (посилання, пояс, дзвінки, статус) за замовчуванням сховані. */
function showAdvanced() {
  PropertiesService.getDocumentProperties().setProperty('showAdvanced', '1');
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_SETTINGS);
  if (sh) sh.showRows(1, sh.getMaxRows());
}

function hideAdvanced() {
  PropertiesService.getDocumentProperties().setProperty('showAdvanced', '0');
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_SETTINGS);
  if (sh) applySettingsVisibility_(sh, String(sh.getRange(CELL_STATUS).getValue() || '') !== OK_STATUS, false);
}

/**
 * Лишає на аркуші «Налаштування» видимою тільки групу.
 * Рядок «Статус» з'являється, лише коли є проблема; рядок з посиланням, лише коли його ще не вказано.
 */
function applySettingsVisibility_(sh, showStatus, showUrl) {
  if (PropertiesService.getDocumentProperties().getProperty('showAdvanced') === '1') return;
  const setRow = function (row, show) { if (show) sh.showRows(row); else sh.hideRows(row); };
  setRow(3, !!showUrl);
  setRow(5, false);
  setRow(6, false);
  setRow(7, !!showStatus);
  sh.hideRows(8, BELLS_FIRST_ROW + MAX_PAIRS - 8); // рядки 8-14: порожній, дзвінки
}

/** Одноразове налаштування: аркуші, тригери, перше оновлення. */
function setup() {
  const ss = SpreadsheetApp.getActive();
  ensureSheets_(ss);
  installTriggers();
  refreshAll();
}

/** Автооновлення: кожні 30 хвилин + щодня о 00:05 + одразу після зміни групи. */
function installTriggers() {
  const ss = SpreadsheetApp.getActive();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const f = t.getHandlerFunction();
    if (f === 'refreshAll' || f === 'onSettingsEdit') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshAll').timeBased().everyMinutes(30).create();
  ScriptApp.newTrigger('refreshAll').timeBased().atHour(0).nearMinute(5).everyDays(1).create();
  ScriptApp.newTrigger('onSettingsEdit').forSpreadsheet(ss).onEdit().create();
}

/** Встановлюваний тригер: коли змінили групу (або посилання) в «Налаштування», оновлюємо все. */
function onSettingsEdit(e) {
  if (!e || !e.range) return;
  const sh = e.range.getSheet();
  if (sh.getName() !== SHEET_SETTINGS) return;
  const a1 = e.range.getA1Notation();
  if (a1 === CELL_GROUP || a1 === CELL_URL) refreshAll();
}

function refreshAll() {
  const ss = SpreadsheetApp.getActive();
  ensureSheets_(ss);
  const settings = ss.getSheetByName(SHEET_SETTINGS);
  const tz = String(settings.getRange(CELL_TZ).getValue() || 'Europe/Kyiv');
  try {
    const data = loadData_(settings);

    // група: список для випадаючого меню + вибір користувача
    const names = listGroups_(data);
    setGroupDropdown_(settings, names);
    const wanted = String(settings.getRange(CELL_GROUP).getValue() || '').trim();
    const g = pickGroup_(data, names, wanted);
    if (g.name !== wanted) settings.getRange(CELL_GROUP).setValue(g.name);

    const bells = readBells_(settings, ss);
    const now = new Date();
    const today = partsFor_(now, tz);
    const tomorrow = partsFor_(new Date(noonOf_(today, tz).getTime() + 24 * 3600 * 1000), tz);

    renderDaySheet_(ss, SHEET_TODAY, 'Сьогодні · ' + g.name, today, g, bells);
    renderDaySheet_(ss, SHEET_TOMORROW, 'Завтра · ' + g.name, tomorrow, g, bells);
    renderWeekSheet_(ss, g, bells, weekDays_(today, tz));

    const meta = data.meta || {};
    const status = buildStatus_(data, g, now);
    settings.getRange(CELL_UPDATED).setValue(meta.generated_at ? formatStamp_(meta.generated_at, tz) : '');
    settings.getRange(CELL_STATUS).setValue(status);

    const props = PropertiesService.getDocumentProperties();
    if (props.getProperty('style_settings') !== STYLE_VER) {
      styleSettingsSheet_(settings);
      props.setProperty('style_settings', STYLE_VER);
    }
    applySettingsVisibility_(settings, status !== OK_STATUS, false);
  } catch (e) {
    settings.getRange(CELL_STATUS).setValue('Помилка оновлення: ' + e.message + ' (' + formatStamp_(new Date().toISOString(), tz) + ')');
    applySettingsVisibility_(settings, true, true); // при помилці показуємо статус і посилання
    throw e;
  }
}

/* ============================ Дані та групи ============================ */

function loadData_(settings) {
  const url = String(settings.getRange(CELL_URL).getValue() || '').trim();
  if (url.indexOf('http') !== 0) {
    throw new Error('У «Налаштування» в клітинці ' + CELL_URL + ' потрібне посилання на JSON з даними (див. інструкцію).');
  }
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'Cache-Control': 'no-cache' } });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Не вдалося завантажити дані, код ' + resp.getResponseCode());
  }
  const data = JSON.parse(resp.getContentText());
  if (!data.schedule && !data.groups) throw new Error('У файлі даних немає розкладу');
  return data;
}

/** Робить назву групи порівнюваною: верхній регістр, без пробілів, латинські двійники → кирилиця. */
function normKey_(s) {
  const map = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', I: 'І', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х' };
  return String(s || '').toUpperCase().replace(/\s+/g, '').replace(/[A-Z]/g, function (ch) { return map[ch] || ch; });
}

/** Усі групи з файлу даних (для випадаючого списку). */
function listGroups_(data) {
  if (data.groups && typeof data.groups === 'object') {
    const keys = Object.keys(data.groups);
    if (keys.length) return keys.sort(function (a, b) { return a.localeCompare(b, 'uk'); });
  }
  return [(data.meta && data.meta.group) || DEFAULT_GROUP];
}

/** Ставить випадаючий список груп у B4. */
function setGroupDropdown_(settings, names) {
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(names, true)
    .setAllowInvalid(false)
    .setHelpText('Виберіть групу зі списку')
    .build();
  const cell = settings.getRange(CELL_GROUP);
  cell.setDataValidation(rule);
  cell.setNote('Виберіть свою групу зі списку. Розклад на всіх аркушах оновиться.');
}

/**
 * Повертає { name, schedule, changes, note } для вибраної групи.
 * Якщо групи немає в даних: група за замовчуванням (або перша зі списку) і примітка.
 */
function pickGroup_(data, names, wanted) {
  const find = function (w) {
    return names.filter(function (n) { return normKey_(n) === normKey_(w); })[0];
  };
  let name = wanted ? find(wanted) : '';
  let note = '';
  if (!name) {
    name = find(DEFAULT_GROUP) || names[0];
    if (wanted) note = 'Групи «' + wanted + '» немає в даних, показано ' + name + '.';
  }
  const src = data.groups ? (data.groups[name] || {}) : data;
  return { name: name, schedule: src.schedule || {}, changes: src.changes || {}, note: note };
}

function buildStatus_(data, g, now) {
  const meta = data.meta || {};
  const msgs = [];
  if (g.note) msgs.push(g.note);
  if (meta.errors && meta.errors.length) msgs.push('Помилки збирання: ' + meta.errors.join('; '));
  if (meta.warnings && meta.warnings.length) msgs.push('Попередження: ' + meta.warnings.join('; '));
  if (meta.generated_at) {
    const ageH = (now.getTime() - new Date(meta.generated_at).getTime()) / 3600000;
    if (ageH > STALE_HOURS) {
      msgs.push('Дані не оновлювались понад ' + STALE_HOURS + ' год, перевірте GitHub Actions.');
    }
  }
  const hasFifth = Object.keys(g.schedule || {}).some(function (d) {
    return !!(g.schedule[d] || {})['5'];
  });
  if (hasFifth) msgs.push('У PDF є 5 пара, вона не показується.');
  return msgs.length ? msgs.join(' | ') : OK_STATUS;
}

/* ============================ Логіка дня (чиста, без SpreadsheetApp) ============================ */

/** Розбирає дату на частини в потрібному часовому поясі. dow: 1=Пн … 7=Нд. */
function partsFor_(date, tz) {
  const key = Utilities.formatDate(date, tz, 'yyyy-MM-dd');
  const dow = parseInt(Utilities.formatDate(date, tz, 'u'), 10);
  const dom = parseInt(Utilities.formatDate(date, tz, 'd'), 10);
  return {
    key: key,
    dow: dow,
    dom: dom,
    display: Utilities.formatDate(date, tz, 'dd.MM.yyyy'),
    parity: dom % 2 === 0 ? 'even' : 'odd',
    parityLabel: dom % 2 === 0 ? 'ЧОТ' : 'НЕ ЧОТ'
  };
}

/** Полудень цієї дати: безпечна точка, щоб додавати добу без проблем із переходом часу. */
function noonOf_(parts, tz) {
  return Utilities.parseDate(parts.key + ' 12:00', tz, 'yyyy-MM-dd HH:mm');
}

function bellText_(bells, n) {
  const b = bells[n];
  return b ? b.start + '–' + b.end : '';
}

/**
 * Збирає розклад на день: звичайні пари за днем тижня й ЧОТ/НЕ ЧОТ (за числом місяця),
 * поверх них заміни. data — об'єкт групи { schedule, changes }. Повертає { rows, status }.
 */
function resolveDay_(data, p, bells) {
  const weekend = p.dow > 5;
  const daySched = weekend ? {} : ((data.schedule || {})[String(p.dow)] || {});
  const dayChanges = (data.changes || {})[p.key];
  const list = dayChanges || [];
  const rows = [];
  const extra = [];

  for (let n = 1; n <= MAX_PAIRS; n++) {
    let entry = null;
    const slot = daySched[String(n)];
    if (slot) entry = slot.mode === 'always' ? slot.entry : slot[p.parity];

    let note = '';
    let kind = entry ? 'normal' : 'none';
    const ch = list.filter(function (c) { return c.pair === n; });
    if (ch.length) {
      const c = ch[ch.length - 1];
      if (c.cancelled) {
        entry = { subject: 'Пару скасовано', teacher: '', room: '' };
        note = 'ЗАМІНА';
        kind = 'cancelled';
      } else {
        entry = { subject: c.subject, teacher: c.teacher, room: c.room };
        note = 'ЗАМІНА';
        kind = 'change';
      }
    }
    rows.push({
      pair: n,
      time: bellText_(bells, n),
      subject: entry ? entry.subject : 'Немає пари',
      teacher: entry ? (entry.teacher || '—') : '—',
      room: entry ? (entry.room || '—') : '—',
      note: note,
      kind: kind
    });
  }
  list.forEach(function (c) { if (c.pair > MAX_PAIRS) extra.push(c.pair + ' пара: ' + c.subject); });

  let status;
  if (list.length === 0) status = weekend ? 'Вихідний. Немає замін' : 'Немає замін';
  else status = (weekend ? 'Вихідний. ' : '') + 'Заміни: ' + list.length + (extra.length ? ' (поза 4 парами: ' + extra.join('; ') + ')' : '');
  return { rows: rows, status: status };
}

/* ============================ «Поточний розклад»: сітка (дні в колонках, пари в рядках) ============================ */

const WEEK_HEAD_ROW = 3;   // рядок із назвами днів
const WEEK_FIRST_ROW = 4;  // перший рядок пар
const WEEK_COLS = 6;       // A: дзвінки, B..F: Пн..Пт

const EMPTY_COLOR = '#c4c9d1';

/**
 * П'ять робочих днів (Пн-Пт) поточного тижня; у суботу й неділю показуємо наступний тиждень.
 * Кожен день розбирається за своєю датою, тож ЧОТ/НЕ ЧОТ і заміни вже враховані, а на аркуші про це нічого не видно.
 */
function weekDays_(today, tz) {
  const offset = today.dow <= 5 ? -(today.dow - 1) : 8 - today.dow;
  const noon = noonOf_(today, tz).getTime();
  const days = [];
  for (let i = 0; i < 5; i++) days.push(partsFor_(new Date(noon + (offset + i) * 24 * 3600 * 1000), tz));
  return days;
}

/** Збирає RichTextValue з частин [{text, bold, color, size}]. */
function richCell_(parts) {
  const text = parts.map(function (p) { return p.text; }).join('');
  const b = SpreadsheetApp.newRichTextValue().setText(text);
  let pos = 0;
  parts.forEach(function (p) {
    if (p.text.length) {
      const st = SpreadsheetApp.newTextStyle()
        .setBold(!!p.bold)
        .setForegroundColor(p.color || TEXT)
        .setFontSize(p.size || 12)
        .build();
      b.setTextStyle(pos, pos + p.text.length, st);
    }
    pos += p.text.length;
  });
  return b.build();
}

function bellRich_(n, bells) {
  const b = bells[n];
  return richCell_([
    { text: n + ' пара\n', color: '#cbd5e1', size: 10 },
    { text: b ? b.start + '\n' + b.end : '', bold: true, color: '#ffffff', size: 16 }
  ]);
}

/**
 * Збирає сітку 4 пари x (дзвінки + 5 днів) для переданих днів.
 * Повертає { rich, h, v, bg }: двовимірні масиви для setRichTextValues, вирівнювання й фону.
 */
function buildWeekGrid_(data, bells, days) {
  const perDay = days.map(function (p) { return resolveDay_(data, p, bells).rows; });
  const rich = [], h = [], v = [], bg = [];
  for (let n = 0; n < MAX_PAIRS; n++) {
    const rr = [bellRich_(n + 1, bells)], hh = ['center'], vv = ['middle'], bb = [NAVY];
    perDay.forEach(function (rows) {
      const r = rows[n];
      if (r.kind === 'none') {
        rr.push(richCell_([{ text: '—', color: EMPTY_COLOR, size: 16 }]));
        hh.push('center'); vv.push('middle'); bb.push(CARD);
      } else {
        const sub = [r.teacher !== '—' ? r.teacher : '', r.room !== '—' ? 'ауд. ' + r.room : '']
          .filter(function (x) { return x; }).join('  ·  ');
        rr.push(richCell_([
          { text: r.subject, bold: true, color: TEXT, size: 12 },
          { text: sub ? '\n' + sub : '', color: MUTED, size: 10 }
        ]));
        hh.push('left'); vv.push('top');
        bb.push(r.kind === 'normal' ? CARD : AMBER);
      }
    });
    rich.push(rr); h.push(hh); v.push(vv); bg.push(bb);
  }
  return { rich: rich, h: h, v: v, bg: bg };
}

function renderWeekSheet_(ss, g, bells, days) {
  const sh = ss.getSheetByName(SHEET_WEEK);
  const props = PropertiesService.getDocumentProperties();
  const relayout = props.getProperty('weekLayout') !== WEEK_LAYOUT;

  // Новий вигляд: один раз чистимо старий і оформлюємо наново.
  if (relayout) {
    sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
    sh.clear();
    styleWeekSheet_(sh);
    props.setProperty('weekLayout', WEEK_LAYOUT);
  }

  sh.getRange('A1').setValue('Поточний розклад · ' + g.name);
  sh.getRange('A2').setValue(days[0].display.slice(0, 5) + ' – ' + days[4].display);
  sh.getRange(WEEK_HEAD_ROW, 1, 1, WEEK_COLS).setValues([[''].concat(days.map(function (p) {
    return DAY_NAMES[p.dow] + '\n' + p.display.slice(0, 5);
  }))]);

  const grid = buildWeekGrid_(g, bells, days);
  const body = sh.getRange(WEEK_FIRST_ROW, 1, MAX_PAIRS, WEEK_COLS);
  body.setRichTextValues(grid.rich);
  body.setHorizontalAlignments(grid.h);
  body.setVerticalAlignments(grid.v);
  body.setBackgrounds(grid.bg);
}

/* ============================ Аркуші ============================ */

function ensureSheets_(ss) {
  const names = [SHEET_TODAY, SHEET_TOMORROW, SHEET_WEEK, SHEET_SETTINGS];
  names.forEach(function (name, i) {
    let sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name, i);
      if (name === SHEET_SETTINGS) initSettings_(sh);
    }
  });
  const settings = ss.getSheetByName(SHEET_SETTINGS);
  if (!settings.getRange('A1').getValue()) initSettings_(settings);
  // Старі правила перевірки даних блокують запис значень: знімаємо їх на всіх аркушах.
  // Випадаючий список груп у B4 ставиться заново в refreshAll.
  names.forEach(function (name) {
    const sh = ss.getSheetByName(name);
    sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).clearDataValidations();
  });
  // порожній стандартний аркуш, якщо лишився
  ['Аркуш1', 'Sheet1'].forEach(function (n) {
    const s = ss.getSheetByName(n);
    if (s && ss.getSheets().length > names.length && s.getLastRow() === 0) ss.deleteSheet(s);
  });
}

function initSettings_(sh) {
  sh.getRange('A1').setValue('Налаштування').setFontWeight('bold').setFontSize(14);
  sh.getRange('A3:A7').setValues([
    ['Посилання на дані (JSON)'], ['Група'], ['Часовий пояс'], ['Дані оновлено'], ['Статус']
  ]);
  if (!sh.getRange(CELL_GROUP).getValue()) sh.getRange(CELL_GROUP).setValue(DEFAULT_GROUP);
  if (!sh.getRange(CELL_TZ).getValue()) sh.getRange(CELL_TZ).setValue('Europe/Kyiv');
  sh.getRange('A9').setValue('Розклад дзвінків (можна редагувати)').setFontWeight('bold');
  sh.getRange('A10:C10').setValues([['Пара', 'Початок', 'Кінець']]).setFontWeight('bold');
  sh.getRange(BELLS_FIRST_ROW, 2, MAX_PAIRS, 2).setNumberFormat('@');
  sh.getRange(BELLS_FIRST_ROW, 1, MAX_PAIRS, 3).setValues(DEFAULT_BELLS);
  sh.setColumnWidth(1, 230);
  sh.setColumnWidth(2, 420);
}

/** Повертає { 1: {start,end}, … } з аркуша «Налаштування». */
function readBells_(settings, ss) {
  const vals = settings.getRange(BELLS_FIRST_ROW, 1, MAX_PAIRS, 3).getValues();
  const tz = ss.getSpreadsheetTimeZone();
  const out = {};
  vals.forEach(function (r) {
    const n = parseInt(r[0], 10);
    if (!n) return;
    out[n] = { start: timeText_(r[1], tz), end: timeText_(r[2], tz) };
  });
  return out;
}

function timeText_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'HH:mm');
  return String(v || '').trim();
}

function formatStamp_(iso, tz) {
  return Utilities.formatDate(new Date(iso), tz, 'dd.MM.yyyy HH:mm');
}

function renderDaySheet_(ss, name, title, parts, data, bells) {
  const sh = ss.getSheetByName(name);
  const props = PropertiesService.getDocumentProperties();
  const styleKey = 'style_' + name;
  const needStyle = sh.getLastRow() === 0 || props.getProperty(styleKey) !== STYLE_VER;
  const day = resolveDay_(data, parts, bells);

  sh.getRange('A1:G14').clearContent();
  sh.getRange('A1').setValue(title);
  sh.getRange('A2').setNumberFormat('@');
  sh.getRange('A2:C2').setValues([[parts.display, DAY_NAMES[parts.dow], '']]);
  sh.getRange('A4:F4').setValues([['Пара', 'Час', 'Предмет', 'Викладач', 'Аудиторія', 'Примітка']]);
  sh.getRange(5, 1, MAX_PAIRS, 6).setValues(day.rows.map(function (r) {
    return [r.pair, r.time, r.subject, r.teacher, r.room, r.note];
  }));
  sh.getRange('A10').setValue(day.status);

  if (needStyle) {
    styleDaySheet_(sh);
    props.setProperty(styleKey, STYLE_VER);
  }
}

/* ============================ Оформлення (один раз після оновлення і за кнопкою меню) ============================ */

const NAVY = '#18304a';   // шапки й колонка з парами
const CARD = '#f3f4f6';   // картки з предметами
const MUTED = '#6b7280';  // викладач, підписи
const TEXT = '#18304a';
const ACCENT = '#1a56db'; // позначки ЧОТ / НЕ ЧОТ
const AMBER = '#fde68a';  // заміни
const GAP = '#ffffff';    // «просвіти» між картками

/** Переоформлює всі аркуші (власні правки кольорів і шрифтів буде замінено) і оновлює дані. */
function styleAll() {
  const ss = SpreadsheetApp.getActive();
  ensureSheets_(ss);
  const props = PropertiesService.getDocumentProperties();
  props.deleteProperty('weekLayout'); // щоб «Поточний розклад» оформився наново
  [SHEET_TODAY, SHEET_TOMORROW].forEach(function (n) {
    styleDaySheet_(ss.getSheetByName(n));
    props.setProperty('style_' + n, STYLE_VER);
  });
  styleSettingsSheet_(ss.getSheetByName(SHEET_SETTINGS));
  props.setProperty('style_settings', STYLE_VER);
  refreshAll(); // перебудує «Поточний розклад» і запише текст з форматуванням
}

function styleTitle_(cell) {
  cell.setFontSize(26).setFontWeight('bold').setFontColor(NAVY).setWrap(false);
}

function styleHeader_(range) {
  range.setBackground(NAVY).setFontColor('#ffffff').setFontWeight('bold').setFontSize(14)
    .setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
}

function styleGaps_(range) {
  range.setBorder(true, true, true, true, true, true, GAP, SpreadsheetApp.BorderStyle.SOLID_THICK);
}

function styleDaySheet_(sh) {
  sh.setHiddenGridlines(true);
  styleTitle_(sh.getRange('A1'));
  sh.getRange('A2:C2').setFontSize(15).setFontWeight('bold').setFontColor(MUTED);
  styleHeader_(sh.getRange('A4:F4'));

  const body = sh.getRange(5, 1, MAX_PAIRS, 6);
  body.setFontSize(16).setFontColor(TEXT).setFontWeight('normal').setBackground(CARD)
    .setVerticalAlignment('middle').setHorizontalAlignment('center').setWrap(true);
  sh.getRange(5, 3, MAX_PAIRS, 1).setHorizontalAlignment('left').setFontWeight('bold');
  sh.getRange(5, 4, MAX_PAIRS, 1).setFontColor(MUTED).setFontSize(14);
  sh.getRange(5, 1, MAX_PAIRS, 2).setBackground(NAVY).setFontColor('#ffffff')
    .setFontWeight('bold').setFontSize(18);
  styleGaps_(sh.getRange(4, 1, MAX_PAIRS + 1, 6));

  sh.getRange('A10').setFontSize(13).setFontStyle('italic').setFontColor(MUTED);
  [90, 150, 440, 230, 130, 130].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.setRowHeight(4, 44);
  for (let r = 5; r < 5 + MAX_PAIRS; r++) sh.setRowHeight(r, 80);

  const rules = [
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$F5="ЗАМІНА"')
      .setBackground(AMBER).setRanges([sh.getRange(5, 3, MAX_PAIRS, 4)]).build()
  ];
  sh.setConditionalFormatRules(rules);
}

function styleWeekSheet_(sh) {
  sh.setHiddenGridlines(true);
  styleTitle_(sh.getRange('A1'));
  sh.getRange('A2').setFontSize(11).setFontStyle('italic').setFontColor(MUTED).setWrap(false);

  styleHeader_(sh.getRange(WEEK_HEAD_ROW, 2, 1, WEEK_COLS - 1));
  sh.getRange(WEEK_HEAD_ROW, 1).setBackground(GAP);

  const body = sh.getRange(WEEK_FIRST_ROW, 1, MAX_PAIRS, WEEK_COLS);
  body.setBackground(CARD).setFontColor(TEXT).setWrap(true);
  sh.getRange(WEEK_FIRST_ROW, 1, MAX_PAIRS, 1).setBackground(NAVY).setFontColor('#ffffff');
  styleGaps_(sh.getRange(WEEK_HEAD_ROW, 1, MAX_PAIRS + 1, WEEK_COLS));

  [110, 200, 200, 200, 200, 200].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.setRowHeight(WEEK_HEAD_ROW, 56);
  for (let r = WEEK_FIRST_ROW; r < WEEK_FIRST_ROW + MAX_PAIRS; r++) sh.setRowHeight(r, 150);
}

function styleSettingsSheet_(sh) {
  styleTitle_(sh.getRange('A1'));
  sh.getRange('A3:A7').setFontWeight('bold').setFontSize(15).setFontColor(NAVY);
  sh.getRange('B3:B7').setFontSize(15).setWrap(true).setHorizontalAlignment('left');
  sh.getRange(CELL_GROUP).setFontWeight('bold').setBackground(CARD);
  sh.getRange('A9').setFontSize(14).setFontWeight('bold').setFontColor(NAVY);
  styleHeader_(sh.getRange('A10:C10'));
  sh.getRange('A11:C14').setFontSize(15).setHorizontalAlignment('center').setBackground(CARD);
  styleGaps_(sh.getRange('A10:C14'));
}
