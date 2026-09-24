package app.drugtracker.notificationruntime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.Set;
import java.util.stream.Collectors;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class NotificationRuntimeRetryPersistenceTest {
    private static final String PREFS =
            "drugtracker_notification_delivery_retry_v2";
    private static final String ENTRY_PREFIX = "entry:";
    private static final int MAX_ENTRIES = 64;

    private NotificationRuntime runtime;
    private SharedPreferences prefs;

    @Before
    public void setUp() {
        Context context = RuntimeEnvironment.getApplication();
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        prefs.edit().clear().commit();
        runtime = new NotificationRuntime(context);
    }

    private NotificationRuntime.Request request(String namespace, String identity) {
        return new NotificationRuntime.Request(
                namespace,
                identity,
                "title",
                "body",
                "test-channel",
                "Test Channel",
                2,
                1,
                "ic_launcher",
                true,
                false,
                null);
    }

    @Test
    public void sameIdentityCreatesOnlyOneRetryRecord() {
        NotificationRuntime.Request first = request("dose", "med-1");
        runtime.persistRetry(first);
        runtime.persistRetry(first);

        assertEquals(1, entryCount());
        String raw = prefs.getString(findEntryKey(), null);
        assertNotNull(raw);
        assertEquals("dose", identityField(raw, "namespace"));
        assertEquals("med-1", identityField(raw, "identity"));
        assertTrue(queuedAt(raw) > 0L);
    }

    @Test
    public void concurrentDistinctIdentitiesDoNotLoseEntries() throws Exception {
        Thread first = new Thread(() -> runtime.persistRetry(request("dose", "med-a")));
        Thread second = new Thread(() -> runtime.persistRetry(request("critical", "med-b")));

        first.start();
        second.start();
        first.join();
        second.join();

        assertEquals(2, entryCount());
        Set<String> identities = prefs.getAll().entrySet().stream()
                .filter(entry -> entry.getKey().startsWith(ENTRY_PREFIX))
                .map(entry -> identityField((String) entry.getValue(), "identity"))
                .collect(Collectors.toSet());
        assertEquals(2, identities.size());
        assertTrue(identities.contains("med-a"));
        assertTrue(identities.contains("med-b"));
    }

    @Test
    public void retryStorageNeverExceedsBoundAndRetainsNewestFailure() {
        for (int i = 0; i < MAX_ENTRIES; i++) {
            runtime.persistRetry(request("dose", "med-" + i));
        }
        runtime.persistRetry(request("dose", "newest"));

        assertEquals(MAX_ENTRIES, entryCount());
        boolean newestPresent = prefs.getAll().entrySet().stream()
                .filter(entry -> entry.getKey().startsWith(ENTRY_PREFIX))
                .map(entry -> identityField((String) entry.getValue(), "identity"))
                .anyMatch("newest"::equals);
        assertTrue(newestPresent);
    }

    @Test
    public void staleRetryCleanupCannotRemoveReplacementForSameIdentity() throws Exception {
        NotificationRuntime.Request first = request("dose", "med-a");
        runtime.persistRetry(first);

        String entryKey = findEntryKey();
        String oldToken = new JSONObject(prefs.getString(entryKey, null))
                .getString("retryToken");

        runtime.persistRetry(first);
        String replacementToken = new JSONObject(prefs.getString(entryKey, null))
                .getString("retryToken");
        assertFalse(oldToken.equals(replacementToken));

        java.lang.reflect.Method clearRetryIfUnchanged =
                NotificationRuntime.class.getDeclaredMethod(
                        "clearRetryIfUnchanged",
                        String.class,
                        String.class);
        clearRetryIfUnchanged.setAccessible(true);

        boolean removed = (Boolean) clearRetryIfUnchanged.invoke(
                runtime, entryKey, oldToken);

        assertFalse(removed);
        assertEquals(1, entryCount());
        assertEquals(
                replacementToken,
                new JSONObject(prefs.getString(entryKey, null))
                        .getString("retryToken"));
    }

    @Test
    public void clearRetryRemovesOnlyMatchingEntry() throws Exception {
        runtime.persistRetry(request("dose", "med-a"));
        runtime.persistRetry(request("dose", "med-b"));

        java.lang.reflect.Method clearRetry =
                NotificationRuntime.class.getDeclaredMethod(
                        "clearRetry",
                        String.class,
                        String.class);
        clearRetry.setAccessible(true);
        clearRetry.invoke(runtime, "dose", "med-a");

        assertEquals(1, entryCount());
        String raw = (String) prefs.getAll().entrySet().stream()
                .filter(entry -> entry.getKey().startsWith(ENTRY_PREFIX))
                .findFirst()
                .orElseThrow()
                .getValue();
        assertEquals("med-b", identityField(raw, "identity"));
    }

    private static long queuedAt(String raw) {
        try {
            return new JSONObject(raw).getLong("queuedAtEpochMs");
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    private int entryCount() {
        int count = 0;
        for (String key : prefs.getAll().keySet()) {
            if (key.startsWith(ENTRY_PREFIX)) count++;
        }
        return count;
    }

    private String findEntryKey() {
        return prefs.getAll().keySet().stream()
                .filter(key -> key.startsWith(ENTRY_PREFIX))
                .findFirst()
                .orElseThrow();
    }

    private static String identityField(String raw, String field) {
        try {
            return new JSONObject(raw).getString(field);
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }
}
