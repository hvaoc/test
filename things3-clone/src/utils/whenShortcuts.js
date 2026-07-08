import { colors } from '../theme';
import { WHEN } from '../store/constants';
import { todayKey, keyToDate, addDays } from './date';

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function nextWeekday(target, keepToday) {
  const today = todayKey();
  const day = keyToDate(today).getDay();
  let add = (target - day + 7) % 7;
  if (add === 0 && !keepToday) add = 7;
  return addDays(today, add);
}

// The quick "when" shortcut rows — the single source of truth shared by the mobile
// quick-add tray (WhenSheet) and the iPad/desktop Date popover, so the two always
// match. The already-selected value is dropped (redundant), and the middle slot
// flips Tomorrow ↔ Later this Week depending on the current selection.
export function whenShortcuts(value) {
  const today = todayKey();
  const tomorrow = addDays(today, 1);
  const weekend = nextWeekday(6, true);
  const nextWeek = nextWeekday(1, false);
  const later = addDays(today, 3);
  const tomorrowRow = { testID: 'when-option-tomorrow', icon: 'partly-sunny', color: colors.deadlineSoon, label: 'Tomorrow', hint: WD[keyToDate(tomorrow).getDay()], value: tomorrow };
  const laterRow = { testID: 'when-option-later', icon: 'calendar-clear-outline', color: '#3aa675', label: 'Later this Week', hint: WD[keyToDate(later).getDay()], value: later };
  const midRow = value === tomorrow ? laterRow : tomorrowRow;
  return [
    { testID: 'when-option-today', icon: 'star', color: colors.today, label: 'Today', hint: WD[keyToDate(today).getDay()], value: WHEN.TODAY },
    { testID: 'when-option-evening', icon: 'moon', color: colors.someday, label: 'This Evening', value: WHEN.EVENING },
    midRow,
    { testID: 'when-option-weekend', icon: 'bed', color: colors.accent, label: 'This Weekend', hint: WD[keyToDate(weekend).getDay()], value: weekend },
    { testID: 'when-option-nextweek', icon: 'arrow-forward-circle', color: '#9b6dff', label: 'Next Week', hint: WD[keyToDate(nextWeek).getDay()], value: nextWeek },
  ].filter((s) => s.value !== value);
}
