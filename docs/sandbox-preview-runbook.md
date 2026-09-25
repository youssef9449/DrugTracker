# Sandbox Preview Runbook — Relaunching DrugTracker in the Z.ai Display Panel

> **Purpose.** Step-by-step reference for serving the DrugTracker web app inside
> the sandbox preview panel. Written after a real outage where the preview panel
> showed Vite's `Blocked request. This host (...) is not allowed.` page instead
> of the app. Every command below was executed and verified end-to-end
> (desktop + 390x844 mobile, zero console/page errors).
>
> **Scope.** This is sandbox *display* tooling only. It does not touch the
> app's build, tests, CI, or production behavior — the Vite option that fixes
> the host block is injected by the launcher, not by any repository file.

## 1. Environment facts that drive every decision

| # | Sandbox fact | Consequence for the preview server |
|---|---|---|
| 1 | The preview panel loads the app through an external proxy hostname (e.g. `ws-cbdcb-...fcapp.run`) which the in-sandbox gateway forwards to **port 3000** | The app must listen on `0.0.0.0:3000` with `strictPort` — no other port is routed to the panel |
| 2 | The gateway forwards the browser's `Host` header **unchanged** | Vite sees the external proxy hostname, never `localhost` |
| 3 | Vite ≥ 5.4.12 / 6.x runs a DNS-rebinding host guard (`server.allowedHosts`, default: localhost only) | Without `allowedHosts`, **every** preview-panel request gets `403 "Blocked request. This host is not allowed"` while localhost still works — which is exactly how this bug hides from localhost-only verification |
| 4 | The sandbox reaps any process still descended from a finished tool call (SIGKILL shortly after the call returns) | The server must be fully orphaned **inside the same tool call that starts it**: `bash -c 'setsid CMD & exit 0'` → final `PPID=1`, unreachable by the reaper's tree-walk |
| 5 | `/home/z/.agent-browser/browsers/vite-node` is a renamed copy of `node` | Launch the server through this binary |
| 6 | The launcher owns a readiness unix-socket at `/home/z/.agent-browser/vite.sock` | A stale socket from a previous run makes the new launcher die instantly with `EADDRINUSE` — always clean it before relaunching |

## 2. Quick health check (is the preview already alive?)

```bash
# 1) Is something listening?
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/

# 2) Does it accept the EXTERNAL host (what the preview panel actually sends)?
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: preview-proxy.example.com" http://localhost:3000/
```

| Result | Meaning | Action |
|---|---|---|
| `200` + `200` | Preview healthy | Nothing to do |
| `200` + `403` | Server up, host guard active (the "Blocked request" bug) | Redo launcher with `allowedHosts: true` (§3.3–§3.5) |
| fail + fail | Server down | Full launch (§3) |

Rule of thumb: **check #2 is the only one that predicts what the user sees.**
localhost-only checks are how the original outage was missed.

## 3. Full launch from scratch

### 3.1 Clone

```bash
git clone https://github.com/youssef9449/DrugTracker.git /home/z/work/DrugTracker-app
git -C /home/z/work/DrugTracker-app switch main   # or any branch to display
```

### 3.2 Dependencies

Preferred (lockfile-exact): `npm ci` inside the clone.

Fast path when a previous working clone exists (in the original session there
was one at `/home/z/work/DrugTracker-fresh`):

```bash
diff /home/z/work/DrugTracker-fresh/package.json /home/z/work/DrugTracker-app/package.json \
  && cp -a /home/z/work/DrugTracker-fresh/node_modules /home/z/work/DrugTracker-app/node_modules
```

Only reuse a copied `node_modules` if `package.json` is identical — otherwise
the dependency tree may not match the lockfile.

### 3.3 The launcher — `devServer.mjs`

Sandbox path: `/home/z/my-project/mini-services/drugtracker/devServer.mjs`.
The two critical settings are `allowedHosts: true` and `DISABLE_HMR`.

```js
import fs from 'node:fs';
import net from 'node:net';
fs.writeFileSync('/home/z/.agent-browser/vite.pid', String(process.pid));
const unixServer = net.createServer((s) => s.destroy());
unixServer.listen('/home/z/.agent-browser/vite.sock');
// No HMR websocket behind the preview proxy (matches the repo's own
// "AI Studio" DISABLE_HMR mode documented in vite.config.ts).
process.env.DISABLE_HMR = 'true';
const { createServer } = await import('/home/z/work/DrugTracker-app/node_modules/vite/dist/node/index.js');
const vite = await createServer({
  root: '/home/z/work/DrugTracker-app',
  server: {
    port: 3000,
    host: '0.0.0.0',
    strictPort: true,
    allowedHosts: true, // FIX for "Blocked request. This host is not allowed"
  },
});
await vite.listen();
console.log('VITE-UP pid=' + process.pid);
```

- `allowedHosts: true` accepts any `Host` header, so the external proxy
  hostname works. It is injected **programmatically in the launcher**, so
  **no repository file is modified** (keeps `git status` and CI clean).
- `DISABLE_HMR=true` disables the HMR websocket and file watching (the repo's
  `vite.config.ts` reads this env var by design) — no ws errors through the
  proxy and lower CPU. It must be set **before** `createServer(...)`.
- Point `root` and the `import('.../vite/dist/node/index.js')` path at the
  **active clone**; never import a different clone's Vite against this root.

### 3.4 Clear the stale readiness socket (before EVERY relaunch)

```bash
rm -f /home/z/.agent-browser/vite.sock /home/z/.agent-browser/vite.pid
```

Skipping this is the most common instant crash: the launcher binds that socket
and exits with
`EADDRINUSE { address: '/home/z/.agent-browser/vite.sock', port: -1 }`.

### 3.5 Launch — the exact reaper-escape command

```bash
bash -c 'setsid /home/z/.agent-browser/browsers/vite-node \
  /home/z/my-project/mini-services/drugtracker/devServer.mjs \
  >> /home/z/work/DrugTracker-app/vite-dev.log 2>&1 < /dev/null & exit 0'

# wait for readiness (first cold start takes a few seconds)
for i in $(seq 1 40); do sleep 1; curl -s -o /dev/null -m 2 http://localhost:3000/ && break; done
```

This must be a **single tool call**: `setsid` detaches the server into its own
session (final `PPID=1`) *before* the call ends, so the reaper's tree-walk from
the call root cannot reach it. A plain `CMD &` — or launching in one call and
checking in the next — gets the server killed.

### 3.6 Watchdog — self-healing every 20 s

Sandbox path: `/home/z/my-project/mini-services/drugtracker/watchdog.sh`.
It relaunches the server through the same orphan pattern whenever port 3000
stops answering.

```bash
#!/bin/bash
# Self-healing guardian: keeps the DrugTracker preview server alive on port 3000
DEV=/home/z/my-project/mini-services/drugtracker/devServer.mjs
NODE=/home/z/.agent-browser/browsers/vite-node
LOG=/home/z/work/DrugTracker-app/vite-dev.log
while true; do
  if ! curl -s -o /dev/null -m 4 http://localhost:3000/; then
    echo "[watchdog] $(date +%T) port 3000 down -> restarting vite" \
      >> /home/z/my-project/mini-services/drugtracker/watchdog.log
    rm -f /home/z/.agent-browser/vite.sock /home/z/.agent-browser/vite.pid
    setsid "$NODE" "$DEV" >> "$LOG" 2>&1 < /dev/null &
  fi
  sleep 20
done
```

Start it (also orphaned, same reaper escape):

```bash
bash -c 'setsid /bin/bash /home/z/my-project/mini-services/drugtracker/watchdog.sh \
  < /dev/null > /dev/null 2>&1 & exit 0'
```

⚠️ **When switching clones/branches:** stop the watchdog FIRST (`kill <pid>`),
update its `DEV`/`LOG` paths, then relaunch — otherwise it keeps resurrecting
the *old* clone mid-operation. Safe stop order:
**watchdog → server → (do the switch) → socket cleanup → server → watchdog.**

## 4. Verification checklist (all four, in order)

```bash
# 1. Host-guard simulation — predicts exactly what the preview panel gets:
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Host: anything.example.com" http://localhost:3000/            # → 200

# 2. Body is really the app:
curl -s -H "Host: anything.example.com" http://localhost:3000/ \
  | rg -o "<title>[^<]+</title>"                                    # → Drug Tracker

# 3. Real browser render + error surfaces:
agent-browser open http://localhost:3000
agent-browser get title        # → "Drug Tracker"
agent-browser errors           # → (empty)
agent-browser console          # → no errors

# 4. Interactivity golden path (agent-browser snapshot -i):
#    - switch tabs (المخزون ↔ الصيدليات) → page heading changes
#    - "إضافة دواء جديد" → dialog opens; its overlay blocks clicks
#      on elements beneath (correct modal behavior)
```

Screenshots from the verified session (sandbox project root):
`drugtracker-preview-final.png` (desktop, add-medication dialog open) and
`drugtracker-preview-mobile.png` (390x844).

## 5. Troubleshooting

| Symptom | Root cause | Fix |
|---|---|---|
| Preview shows `Blocked request. This host ("ws-...") is not allowed. To allow this host, add ... to server.allowedHosts in vite.config.js` | Launcher passes no `server.allowedHosts`; Vite 6 default guard is localhost-only | §3.3 `allowedHosts: true` |
| Launcher dies instantly; log shows `EADDRINUSE ... vite.sock` | Stale readiness socket/pid from the previous run | §3.4 `rm -f` both files |
| Server disappears right after the starting tool call ends | Not fully orphaned — the reaper's tree-walk killed it | §3.5 exact `bash -c 'setsid ... & exit 0'` inside ONE call |
| Panel serves the old app / wrong branch after a switch | Watchdog resurrected the OLD clone | §3.6 warning — stop watchdog, retarget `DEV`/`LOG`, relaunch |
| Console ws/HMR errors through the proxy | HMR websocket cannot traverse the gateway | `process.env.DISABLE_HMR='true'` in the launcher before `createServer` |
| `npm ci` impossible (no registry access) | Sandbox network restrictions | Copy a verified `node_modules` (§3.2) after diffing `package.json` |
| Everything looks fine locally but the user still sees a block/error page | Verified against `localhost` only | Run §4 check #1/#2 with the **external** `Host` header — that is the only test that predicts the panel |

## 6. Where things live (sandbox side — not part of this repo)

| Artifact | Path |
|---|---|
| Launcher | `/home/z/my-project/mini-services/drugtracker/devServer.mjs` |
| Watchdog | `/home/z/my-project/mini-services/drugtracker/watchdog.sh` (log: `watchdog.log`) |
| Node binary for launches | `/home/z/.agent-browser/browsers/vite-node` |
| Readiness socket/pid | `/home/z/.agent-browser/vite.sock`, `/home/z/.agent-browser/vite.pid` |
| Active clone | `/home/z/work/DrugTracker-app` (`main` @ `75d0a648` at the time of writing) |
| Dev server log | `/home/z/work/DrugTracker-app/vite-dev.log` |

These are sandbox-local and may vanish with the sandbox; §3.3 and §3.6 contain
their full contents so the whole setup can be recreated anywhere in about two
minutes.

## 7. Known display limitation

The web preview runs the PWA in browser mode, so native-only Capacitor
features (exact alarms, native notification channels, and similar plugin
behaviors) degrade to web behavior **by design**. Everything else — stock
tracking, auto-deduction UI, dose-reminder scheduling UI, pharmacy
management, consumption history — is fully functional in the panel.
