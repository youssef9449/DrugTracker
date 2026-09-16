package com.getcapacitor;

import org.json.JSONObject;

/** Test double for Capacitor JSObject (jvm-tests only). */
public class JSObject {
    private final JSONObject json;

    public JSObject() {
        this.json = new JSONObject();
    }

    public JSObject(String raw) throws Exception {
        this.json = new JSONObject(raw);
    }

    public JSObject(JSONObject json) {
        this.json = json != null ? json : new JSONObject();
    }

    public JSObject getJSObject(String key) {
        if (!json.has(key) || json.isNull(key)) {
            return null;
        }
        try {
            Object v = json.get(key);
            if (v instanceof JSONObject) {
                return new JSObject((JSONObject) v);
            }
            if (v instanceof String) {
                return new JSObject((String) v);
            }
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    public String getString(String key) {
        return json.optString(key, null);
    }

    public Boolean getBool(String key) {
        if (!json.has(key) || json.isNull(key)) {
            return null;
        }
        try {
            return json.getBoolean(key);
        } catch (Exception e) {
            return null;
        }
    }

    public boolean has(String key) {
        return json.has(key);
    }

    public void put(String key, Object value) {
        try {
            if (value instanceof JSObject) {
                json.put(key, ((JSObject) value).json);
            } else {
                json.put(key, value);
            }
        } catch (Exception ignored) {
        }
    }

    @Override
    public String toString() {
        return json.toString();
    }
}
