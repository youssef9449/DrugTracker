package com.getcapacitor;

import android.content.Context;

/** Minimal Capacitor Plugin test double for JVM-only native boundary tests. */
public class Plugin {
    private Context context;

    public Context getContext() {
        return context;
    }

    public void setContext(Context context) {
        this.context = context;
    }
}
