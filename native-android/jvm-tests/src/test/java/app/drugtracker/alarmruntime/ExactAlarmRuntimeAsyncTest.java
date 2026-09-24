package app.drugtracker.alarmruntime;

import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

public class ExactAlarmRuntimeAsyncTest {
    @Test
    public void executeAsyncRunsOffTheCallerThread() throws Exception {
        String callerThread = Thread.currentThread().getName();
        CountDownLatch completed = new CountDownLatch(1);
        AtomicReference<String> workerThread = new AtomicReference<>();

        ExactAlarmRuntime.executeAsync(() -> {
            workerThread.set(Thread.currentThread().getName());
            completed.countDown();
        });

        assertTrue(
                "exact-alarm background operation did not run",
                completed.await(2, TimeUnit.SECONDS));
        assertNotEquals(callerThread, workerThread.get());
        assertTrue(workerThread.get().contains("ExactAlarmRuntime"));
    }
}
