// Date helpers. Internally we store calendar dates as "YYYY-MM-DD" strings so we
// never wrestle with timezones — a deadline of "the 5th" should be the 5th no
// matter where the user is.

export function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

export { MONTHS, MONTHS_SHORT, WEEKDAYS, WEEKDAYS_SHORT };
