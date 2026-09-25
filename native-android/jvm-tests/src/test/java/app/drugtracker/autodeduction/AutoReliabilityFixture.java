package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.AutoDeductionTestSupport.appContext;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.clearAllDurableState;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.evtKey;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.eventPrefs;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.schKey;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.schedulePrefs;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.SharedPreferences;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Locale;
import java.util.TimeZone;

abstract class Group2AutoReliabilityFixture {

    @Before
    public void setUp() {
        AutoDeductionTestSupport.clearAllDurableState();
    }

    protected static String occurrenceKey(String med, String dose, String date) {
        return AutoDeductionContract.occurrenceKey(med, dose, date);
    }

    protected static String localDateOffset(int days) {
        Calendar cal = Calendar.getInstance(TimeZone.getDefault(), Locale.US);
        cal.add(Calendar.DAY_OF_MONTH, days);
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(cal.getTime());
    }

    protected static long epoch(String date, String time) {
        Long value = AutoDeductionScheduler.computeEpochMs(date, time);
        assertNotNull(value);
        return value;
    }

    protected static void seedGeneration(String med, String dose, long generation) {
        appContext()
                .getSharedPreferences(
                        AutoDeductionContract.PREFS_RECURRENCE_AUTH,
                        0)
                .edit()
                .putLong(
                        AutoDeductionContract.RECURRENCE_AUTH_KEY_PREFIX
                                + AutoDeductionContract.scheduleIdentityKey(med, dose),
                        generation)
                .commit();
    }

    protected static void putSchedule(
            String med,
            String dose,
            String date,
            String time,
            double amount,
            String operationVersion,
            long generation) throws Exception {
        JSONObject row = new JSONObject();
        row.put("medicationId", med);
        row.put("doseId", dose);
        row.put("calendarDate", date);
        row.put("timeHhmm", time);
        row.put("amount", amount);
        row.put("scheduledAtEpochMs", epoch(date, time));
        row.put("operationVersion", operationVersion);
        row.put("recurrenceGeneration", generation);
        schedulePrefs()
                .edit()
                .putString(
                        schKey(occurrenceKey(med, dose, date)),
                        row.toString())
                .commit();
    }

}
