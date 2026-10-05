/**
 * Розклад ЗТК для Google Sheets.
 *
 * Скрипт НЕ містить жодного предмета, викладача чи аудиторії: усе приходить із
 * файлу data/a20.json, який GitHub Actions автоматично збирає з PDF на сайті ЗТК.
 * Скрипт відповідає лише за дані та структуру аркушів, оформлення (кольори,
 * шрифти, ширини) ви змінюєте вручну, скрипт його не перезаписує.
 *
 * Перший запуск: виберіть функцію setup() і натисніть «Виконати».
 */

const SHEET_TODAY = 'Сьогодні';
const SHEET_TOMORROW = 'Завтра';
const SHEET_WEEK = 'Поточний розклад';
const SHEET_SETTINGS = 'Налаштування';

const MAX_PAIRS = 4; // п'ятої пари немає
const DAY_NAMES = ['', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота', 'Неділя'];
const DEFAULT_BELLS = [['1', '08:00', '09:20'], ['2', '09:30', '10:50'], ['3', '11:20', '12:40'], ['4', '12:50', '14:10']];
const STALE_HOURS = 72;

// клітинки на аркуші «Налаштування»
const CELL_URL = 'B3';
const CELL_GROUP = 'B4';
const CELL_TZ = 'B5';
const CELL_UPDATED = 'B6';
const CELL_STATUS = 'B7';
const BELLS_FIRST_ROW = 11; // A11:C14

/* ============================ Меню і запуск ============================ */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Розклад')
    .addItem('Оновити зараз', 'refreshAll')
    .addItem('Увімкнути автооновлення', 'installTriggers')
    .addToUi();
}

/** Одноразове налаштування: аркуші, тригери, перше оновлення. */
function setup() {
  const ss = SpreadsheetApp.getActive();
  ensureSheets_(ss);
  installTriggers();
  refreshAll();
}

/** Автооновлення: кожні 30 хвилин + щодня о 00:05 (зміна дати). */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'refreshAll') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshAll').timeBased().everyMinutes(30).create();
  ScriptApp.newTrigger('refreshAll').timeBased().atHour(0).nearMinute(5).everyDays(1).create();
}

function refreshAll() {
  const ss = SpreadsheetApp.getActive();
  ensureSheets_(ss);
  const settings = ss.getSheetByName(SHEET_SETTINGS);
  const tz = String(settings.getRange(CELL_TZ).getValue() || 'Europe/Kyiv');
  try {
    const data = loadData_(settings);
    const bells = readBells_(settings, ss);
    const now = new Date();
    const today = partsFor_(now, tz);
    const tomorrow = partsFor_(new Date(noonOf_(today, tz).getTime() + 24 * 3600 * 1000), tz);

    renderDaySheet_(ss, SHEET_TODAY, 'Сьогодні', today, data, bells);
    renderDaySheet_(ss, SHEET_TOMORROW, 'Завтра', tomorrow, data, bells);
    renderWeekSheet_(ss, data, bells);

    const meta = data.meta || {};
    settings.getRange(CELL_GROUP).setValue(meta.group || '');
    settings.getRange(CELL_UPDATED).setValue(meta.generated_at ? formatStamp_(meta.generated_at, tz) : '');
    settings.getRange(CELL_STATUS).setValue(buildStatus_(data, now));
  } catch (e) {
    settings.getRange(CELL_STATUS).setValue('Помилка оновлення: ' + e.message + ' (' + formatStamp_(new Date().toISOString(), tz) + ')');
    throw e;
  }
}

/* ============================ Дані ============================ */

function loadData_(settings) {
  const url = String(settings.getRange(CELL_URL).getValue() || '').trim();
  if (url.indexOf('http') !== 0) {
    throw new Error('У «Налаштування» в клітинці ' + CELL_URL + ' потрібне посилання на a20.json (див. інструкцію).');
  }
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'Cache-Control': 'no-cache' } });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Не вдалося завантажити дані, код ' + resp.getResponseCode());
  }
  const data = JSON.parse(resp.getContentText());
  if (!data.schedule) throw new Error('У файлі даних немає розкладу');
  return data;
}

function buildStatus_(data, now) {
  const meta = data.meta || {};
  const msgs = [];
  if (meta.errors && meta.errors.length) msgs.push('Помилки збирання: ' + meta.errors.join('; '));
  if (meta.warnings && meta.warnings.length) msgs.push('Попередження: ' + meta.warnings.join('; '));
  if (meta.generated_at) {
    const ageH = (now.getTime() - new Date(meta.generated_at).getTime()) / 3600000;
    if (ageH > STALE_HOURS) {
      msgs.push('Дані не оновлювались понад ' + STALE_HOURS + ' год, перевірте GitHub Actions.');
    }
  }
  const hasFifth = Object.keys(data.schedule || {}).some(function (d) {
    return !!(data.schedule[d] || {})['5'];
  });
  if (hasFifth) msgs.push('У PDF є 5 пара, вона не показується.');
  return msgs.length ? msgs.join(' | ') : 'Усе гаразд';
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
 * поверх них заміни. Повертає { rows, status }.
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

/** Рядки аркуша «Поточний розклад»: по два на пару (ЧОТ зверху, НЕ ЧОТ знизу). */
function buildWeekRows_(data, bells) {
  const rows = []; // { day, pair, time, half: 0|1, subject, teacher, room, label }
  const merges = [];
  for (let d = 1; d <= 5; d++) {
    for (let n = 1; n <= MAX_PAIRS; n++) {
      const slot = ((data.schedule || {})[String(d)] || {})[String(n)];
      const first = rows.length;
      const time = bellText_(bells, n);
      const base = { day: DAY_NAMES[d], pair: n, time: time };
      if (!slot) {
        rows.push(Object.assign({}, base, { subject: '', teacher: '', room: '', label: '' }));
        rows.push(Object.assign({}, base, { subject: '', teacher: '', room: '', label: '' }));
      } else if (slot.mode === 'always') {
        const e = slot.entry;
        rows.push(Object.assign({}, base, { subject: e.subject, teacher: e.teacher, room: e.room, label: '' }));
        rows.push(Object.assign({}, base, { subject: '', teacher: '', room: '', label: '' }));
        merges.push({ row: first, cols: [4, 5, 6, 7] });
      } else {
        const ev = slot.even, od = slot.odd;
        rows.push(Object.assign({}, base, {
          subject: ev ? ev.subject : '', teacher: ev ? ev.teacher : '', room: ev ? ev.room : '', label: 'ЧОТ'
        }));
        rows.push(Object.assign({}, base, {
          subject: od ? od.subject : '', teacher: od ? od.teacher : '', room: od ? od.room : '', label: 'НЕ ЧОТ'
        }));
      }
      merges.push({ row: first, cols: [2, 3] });
    }
  }
  return { rows: rows, merges: merges };
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
  // Старі правила перевірки даних (dropdown з минулих версій) блокують запис значень:
  // знімаємо їх на всіх чотирьох аркушах.
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
  const isNew = sh.getLastRow() === 0;
  const day = resolveDay_(data, parts, bells);

  sh.getRange('A1:G14').clearContent();
  sh.getRange('A1').setValue(title);
  sh.getRange('A2').setNumberFormat('@');
  sh.getRange('A2:C2').setValues([[parts.display, DAY_NAMES[parts.dow], parts.parityLabel]]);
  sh.getRange('A4:F4').setValues([['Пара', 'Час', 'Предмет', 'Викладач', 'Аудиторія', 'Примітка']]);
  sh.getRange(5, 1, MAX_PAIRS, 6).setValues(day.rows.map(function (r) {
    return [r.pair, r.time, r.subject, r.teacher, r.room, r.note];
  }));
  sh.getRange('A10').setValue(day.status);

  if (isNew) {
    sh.getRange('A1').setFontWeight('bold').setFontSize(16);
    sh.getRange('A2:C2').setFontWeight('bold');
    sh.getRange('A4:F4').setFontWeight('bold').setBackground('#e8eaed');
    sh.setColumnWidth(3, 330);
    sh.setColumnWidth(4, 160);
    const rule = SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$F5="ЗАМІНА"')
      .setBackground('#fff2cc')
      .setRanges([sh.getRange(5, 1, MAX_PAIRS, 6)])
      .build();
    sh.setConditionalFormatRules([rule]);
  }
}

function renderWeekSheet_(ss, data, bells) {
  const sh = ss.getSheetByName(SHEET_WEEK);
  const isNew = sh.getLastRow() === 0;
  const built = buildWeekRows_(data, bells);
  const FIRST = 4;
  const nRows = built.rows.length;
  const props = PropertiesService.getDocumentProperties();
  const signature = JSON.stringify(built.merges);

  sh.getRange('A1').setValue('Поточний розклад');
  sh.getRange('A3:G3').setValues([['День', 'Пара', 'Час', 'Предмет', 'Викладач', 'Аудиторія', 'Парність']]);

  const body = sh.getRange(FIRST, 1, nRows, 7);
  if (props.getProperty('weekMergeSig') !== signature) {
    body.breakApart();
    body.clearContent();
  } else {
    body.clearContent();
  }

  // День: одна об'єднана клітинка на 8 рядків (4 пари × 2)
  const values = built.rows.map(function (r, i) {
    const firstOfDay = i % (MAX_PAIRS * 2) === 0;
    const firstOfPair = i % 2 === 0;
    return [
      firstOfDay ? r.day : '',
      firstOfPair ? r.pair : '',
      firstOfPair ? r.time : '',
      r.subject, r.teacher, r.room, r.label
    ];
  });
  sh.getRange(FIRST, 1, nRows, 7).setValues(values);

  if (props.getProperty('weekMergeSig') !== signature) {
    for (let d = 0; d < 5; d++) sh.getRange(FIRST + d * MAX_PAIRS * 2, 1, MAX_PAIRS * 2, 1).merge();
    built.merges.forEach(function (m) {
      m.cols.forEach(function (c) { sh.getRange(FIRST + m.row, c, 2, 1).merge(); });
    });
    props.setProperty('weekMergeSig', signature);
  }

  if (isNew) {
    sh.getRange('A1').setFontWeight('bold').setFontSize(16);
    sh.getRange('A3:G3').setFontWeight('bold').setBackground('#e8eaed');
    sh.getRange(FIRST, 1, nRows, 7).setVerticalAlignment('middle');
    sh.setColumnWidth(4, 330);
    sh.setColumnWidth(5, 160);
  }
}
