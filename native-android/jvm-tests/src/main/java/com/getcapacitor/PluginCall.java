package com.getcapacitor;

/** Minimal Capacitor PluginCall test double for JVM-only native boundary tests. */
public class PluginCall {
    public String getString(String key) { return null; }
    public String getString(String key, String defaultValue) { return defaultValue; }
    public Long getLong(String key) { return null; }
    public Integer getInt(String key) { return null; }
    public Boolean getBoolean(String key) { return null; }
    public void resolve(JSObject value) {}
    public void reject(String message) {}
}
