package com.getcapacitor;

/** Test double for Capacitor Logger (jvm-tests only). */
public final class Logger {
    private Logger() {}

    public static String tags(String tag) {
        return tag;
    }

    public static void debug(String tag, String message) {}

    public static void warn(String tag, String message) {}

    public static void error(String tag, String message, Throwable t) {}
}
