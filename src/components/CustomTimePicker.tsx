import React, { useMemo } from 'react';

/**
 * A theme-styled 3-dropdown time picker (hour / minute / AM-PM)
 * used inside AddMedicationModal for the "وقت التذكير اليومي" field.
 *
 * Why we don't use <input type="time">
 * ----------------------------------
 * The native <input type="time"> control opens the OS time picker
 * dialog when clicked. On Android, that dialog uses Material design
 * colors based on the system theme. Two problems:
 *
 * 1. The AM/PM dropdown inside the OS picker shows option text in
 *    the system theme color (often white or light-gray) on top of
 *    the same color background — making the text effectively
 *    invisible.
 *
 * 2. The OS picker's visual style doesn't match the app's teal/amber
 *    theme. We get a Material-style blue/purple picker instead of
 *    the app's warm amber reminder block.
 *
 * Solution: render three styled <select> elements that match the
 * app theme. The dropdown options inherit the app's text color
 * (dark slate) and the dropdown panel uses the browser-default
 * light background — the text is always readable.
 *
 * Value format
 * ------------
 * The reminderTime state is a 24-hour "HH:MM" string (e.g.,
 * "09:00", "21:30"). This component converts that to/from 3 fields:
 *   - hour12 (1..12)
 *   - minute (00..59)
 *   - isPM (true = PM, false = AM)
 *
 * Edge cases
 * ----------
 * - 00:00 → 12:00 AM (midnight)
 * - 12:00 → 12:00 PM (noon)
 * - 13:00 → 01:00 PM
 * - 23:59 → 11:59 PM
 */

interface CustomTimePickerProps {
  value: string; // "HH:MM" 24-hour format
  onChange: (next: string) => void;
}

const HOUR_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const MINUTE_OPTIONS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 59];
// Note: minute list ends with 59 so users can pick the last minute of
// an hour too. Common multiples of 5 are listed first for quick
// selection.

export const CustomTimePicker: React.FC<CustomTimePickerProps> = ({
  value,
  onChange,
}) => {
  // Parse the incoming "HH:MM" string into 3 fields. Falls back to
  // 9:00 AM if the value is malformed/empty.
  const parsed = useMemo(() => parseToHourMinute(value), [value]);

  // Build a new "HH:MM" string whenever any of the 3 fields change.
  const update = (hour12: number, minute: number, isPM: boolean) => {
    onChange(formatTo24Hour(hour12, minute, isPM));
  };

  const selectClass =
    'flex-1 px-2 py-2 rounded-xl border border-amber-300 bg-white text-sm font-mono font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-amber-500 appearance-none cursor-pointer';

  return (
    <div className="flex items-stretch gap-2">
      {/* Hour (1-12) */}
      <div className="flex-1 relative">
        <select
          aria-label="ساعة"
          value={parsed.hour12}
          onChange={(e) =>
            update(parseInt(e.target.value, 10), parsed.minute, parsed.isPM)
          }
          className={selectClass}
        >
          {HOUR_OPTIONS.map((h) => (
            <option key={h} value={h}>
              {String(h).padStart(2, '0')}
            </option>
          ))}
        </select>
        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-amber-700 text-[10px] pointer-events-none font-bold">
          ساعة
        </span>
      </div>

      <span className="self-center text-amber-700 font-bold text-lg">:</span>

      {/* Minute (00-59) */}
      <div className="flex-1 relative">
        <select
          aria-label="دقيقة"
          value={parsed.minute}
          onChange={(e) =>
            update(parsed.hour12, parseInt(e.target.value, 10), parsed.isPM)
          }
          className={selectClass}
        >
          {MINUTE_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {String(m).padStart(2, '0')}
            </option>
          ))}
        </select>
        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-amber-700 text-[10px] pointer-events-none font-bold">
          دقيقة
        </span>
      </div>

      {/* AM/PM */}
      <div className="w-[72px]">
        <select
          aria-label="صباحاً أم مساءً"
          value={parsed.isPM ? 'PM' : 'AM'}
          onChange={(e) =>
            update(parsed.hour12, parsed.minute, e.target.value === 'PM')
          }
          className="w-full px-2 py-2 rounded-xl border border-amber-300 bg-amber-50 text-sm font-bold text-amber-900 focus:outline-none focus:ring-2 focus:ring-amber-500 appearance-none cursor-pointer text-center"
        >
          <option value="AM">ص</option>
          <option value="PM">م</option>
        </select>
      </div>
    </div>
  );
};

/**
 * Parse a 24-hour "HH:MM" string into { hour12, minute, isPM }.
 * Defaults to 9:00 AM if the input is malformed.
 */
function parseToHourMinute(value: string): {
  hour12: number;
  minute: number;
  isPM: boolean;
} {
  if (!value || !/^\d{1,2}:\d{2}$/.test(value)) {
    return { hour12: 9, minute: 0, isPM: false };
  }
  const [hStr, mStr] = value.split(':');
  let h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (isNaN(h) || isNaN(m)) return { hour12: 9, minute: 0, isPM: false };

  const isPM = h >= 12;
  // Convert 24-hour to 12-hour:
  //   0  → 12 AM (midnight)
  //   1..11 → 1..11 AM
  //   12 → 12 PM (noon)
  //   13..23 → 1..11 PM
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;

  return { hour12: h, minute: m, isPM };
}

/**
 * Build a 24-hour "HH:MM" string from { hour12, minute, isPM }.
 */
function formatTo24Hour(hour12: number, minute: number, isPM: boolean): string {
  let h24 = hour12;
  if (isPM && hour12 === 12) h24 = 12; // 12 PM stays as 12 (noon)
  else if (isPM && hour12 !== 12) h24 = hour12 + 12; // 1 PM = 13, 11 PM = 23
  else if (!isPM && hour12 === 12) h24 = 0; // 12 AM = 0 (midnight)
  // AM + 1..11 stays as 1..11

  const hh = String(h24).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `${hh}:${mm}`;
}
