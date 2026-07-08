// Date helpers. Internally we store calendar dates as "YYYY-MM-DD" strings so we
// never wrestle with timezones — a deadline of "the 5th" should be the 5th no
// matter where the user is.

// Active timezone for computing "now"/"today". null = the device's local zone.
// Stored calendar dates (YYYY-MM-DD) stay absolute; only the notion of the
// current date/time is shifted. Kept in sync from the timezone setting.
let activeTimeZone = null;
export function setTimeZone(tz) {
  activeTimeZone = tz || null;
}

// Wall-clock parts of the current moment in the active timezone.
function nowParts() {
  const d = new Date();
  if (!activeTimeZone) {
    return { y: d.getFullYear(), m: d.getMonth() + 1, day: d.getDate(), h: d.getHours(), min: d.getMinutes() };
  }
  try {
    const p = {};
    new Intl.DateTimeFormat('en-US', {
      timeZone: activeTimeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
      .formatToParts(d)
      .forEach((x) => { p[x.type] = x.value; });
    return { y: +p.year, m: +p.month, day: +p.day, h: +(p.hour === '24' ? '0' : p.hour), min: +p.minute };
  } catch {
    return { y: d.getFullYear(), m: d.getMonth() + 1, day: d.getDate(), h: d.getHours(), min: d.getMinutes() };
  }
}

// With a Date argument: format that date's calendar day (absolute, unchanged).
// Without one: today's date in the active timezone.
export function todayKey(d) {
  if (d === undefined) {
    const { y, m, day } = nowParts();
    return `${y}-${pad2(m)}-${pad2(day)}`;
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Minutes-since-midnight of the current moment in the active timezone.
export function nowMinutes() {
  const { h, min } = nowParts();
  return h * 60 + min;
}

export function dateToKey(date) {
  return todayKey(date);
}

export function keyToDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(key, n) {
  const d = keyToDate(key);
  d.setDate(d.getDate() + n);
  return todayKey(d);
}

export function isPast(key) {
  if (!key) return false;
  return key < todayKey();
}

export function isToday(key) {
  return key === todayKey();
}

export function isFuture(key) {
  if (!key) return false;
  return key > todayKey();
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Human friendly relative label, the way Things shows dates: "Today",
// "Tomorrow", "Mon", "Apr 12".
export function relativeLabel(key) {
  if (!key) return '';
  const today = todayKey();
  if (key === today) return 'Today';
  if (key === addDays(today, 1)) return 'Tomorrow';
  if (key === addDays(today, -1)) return 'Yesterday';

  const date = keyToDate(key);
  const diff = Math.round((date - keyToDate(today)) / 86400000);
  // Within the next week, show the weekday name.
  if (diff > 0 && diff < 7) return WEEKDAYS_SHORT[date.getDay()];

  const sameYear = date.getFullYear() === new Date().getFullYear();
  return sameYear
    ? `${MONTHS_SHORT[date.getMonth()]} ${date.getDate()}`
    : `${MONTHS_SHORT[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

export function longLabel(key) {
  if (!key) return '';
  const date = keyToDate(key);
  return `${WEEKDAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

export function monthTitle(key) {
  const date = keyToDate(key);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return sameYear
    ? MONTHS[date.getMonth()]
    : `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

// Always "Month YYYY" — the multi-year scroll calendar needs the year on every
// month and must not double it the way monthTitle + a manual year would.
export function monthYearTitle(key) {
  const date = keyToDate(key);
  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

const pad2 = (n) => String(n).padStart(2, '0');

// Predefined absolute-date formats, offered as a preference and used for the
// Calendar Day-view date headers. 'weekday-long' matches the original default.
export const DATE_FORMATS = [
  'weekday-long', // Thursday, Jul 2
  'weekday-short', // Thu, Jul 2
  'month-day-year', // Jul 2, 2026
  'us', // 07/02/2026
  'iso', // 2026-07-02
];

export function formatDayKey(key, id = 'weekday-long') {
  if (!key) return '';
  const d = keyToDate(key);
  const wd = d.getDay();
  const mo = d.getMonth();
  const day = d.getDate();
  const yr = d.getFullYear();
  switch (id) {
    case 'weekday-short':
      return `${WEEKDAYS_SHORT[wd]}, ${MONTHS_SHORT[mo]} ${day}`;
    case 'month-day-year':
      return `${MONTHS_SHORT[mo]} ${day}, ${yr}`;
    case 'us':
      return `${pad2(mo + 1)}/${pad2(day)}/${yr}`;
    case 'iso':
      return `${yr}-${pad2(mo + 1)}-${pad2(day)}`;
    case 'weekday-long':
    default:
      return `${WEEKDAYS[wd]}, ${MONTHS_SHORT[mo]} ${day}`;
  }
}

export { MONTHS, MONTHS_SHORT, WEEKDAYS, WEEKDAYS_SHORT };
