package app.drugtracker.autodeduction;

import android.net.Uri;

    public static boolean isValidAmount(double amount) {
        return !Double.isNaN(amount) && !Double.isInfinite(amount) && amount > 0;
    }

    /**
     * Strict YYYY-MM-DD validation. Rejects structurally valid but impossible dates
     * (e.g. 2026-02-31, 2026-13-01) without relying on Calendar lenient normalization.
     * Leap-year February 29 is accepted only for leap years.
     */
    public static boolean isValidCalendarDate(String date) {
        if (date == null || date.length() != 10) return false;
        for (int i = 0; i < 10; i++) {
            char c = date.charAt(i);
            if (i == 4 || i == 7) {
                if (c != '-') return false;
            } else if (c < '0' || c > '9') {
                return false;
            }
        }
        int year;
        int month;
        int day;
        try {
            year = Integer.parseInt(date.substring(0, 4));
            month = Integer.parseInt(date.substring(5, 7));
            day = Integer.parseInt(date.substring(8, 10));
        } catch (NumberFormatException e) {
            return false;
        }
        if (month < 1 || month > 12) return false;
        if (day < 1) return false;
        int maxDay;
        switch (month) {
            case 1: case 3: case 5: case 7: case 8: case 10: case 12:
                maxDay = 31;
                break;
            case 4: case 6: case 9: case 11:
                maxDay = 30;
                break;
            case 2:
                maxDay = isGregorianLeapYear(year) ? 29 : 28;
                break;
            default:
                return false;
        }
        return day <= maxDay;
    }

    /** Gregorian leap-year rule (proleptic). */
    static boolean isGregorianLeapYear(int year) {
        if (year % 4 != 0) return false;
        if (year % 100 != 0) return true;
        return year % 400 == 0;
    }

    public static boolean isValidTimeHhmm(String time) {
        if (time == null) return false;
        if (time.length() < 4 || time.length() > 5) return false;
        int colon = time.indexOf(':');
        if (colon < 1) return false;
        try {
            int h = Integer.parseInt(time.substring(0, colon));
            int m = Integer.parseInt(time.substring(colon + 1));
            return h >= 0 && h <= 23 && m >= 0 && m <= 59;
        } catch (NumberFormatException e) {
            return false;
        }
    }
}
