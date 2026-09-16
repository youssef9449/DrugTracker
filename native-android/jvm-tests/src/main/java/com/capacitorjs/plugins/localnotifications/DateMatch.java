package com.capacitorjs.plugins.localnotifications;

import java.util.Date;

/** Stub for jvm-tests. */
public class DateMatch {
    public static DateMatch fromMatchString(String s) {
        return new DateMatch();
    }

    public long nextTrigger(Date from) {
        return from.getTime() + 86_400_000L;
    }
}
