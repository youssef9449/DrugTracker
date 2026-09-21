import { useEffect, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';

/**
 * "New version available" prompt for the service worker (M10).
 *
 * The SW (`public/sw.js`) installs a new version in the background but
 * does NOT `skipWaiting()` on its own — it waits until the page sends
 * a `SKIP_WAITING` message. This component:
 *   1. Listens for the `updatefound` → `installed` lifecycle on the
 *      registered ServiceWorkerRegistration.
 *   2. When a new SW is installed and waiting, shows a small
 *      non-blocking banner: "تحديث جديد متاح" with a refresh button.
 *   3. On click, sends `SKIP_WAITING` to the waiting SW and reloads
 *      the page once the new SW takes control (`controllerchange`).
 *
 * Only rendered in production (the SW is only registered in prod —
 * see src/main.tsx), so this component is a no-op in dev.
 *
 * Reload guard: `controllerchange` also fires on the FIRST visit when
 * the SW activates and calls `clients.claim()` (controller goes
 * null → SW). We must NOT reload in that case, or the user gets an
 * unwanted reload on first load. We track an `activatedRef` that is
 * set true only when the user actually clicks the update button, and
 * only reload on `controllerchange` if `activatedRef.current` is true.
 *
 * #33: all event listeners (controllerchange, updatefound, statechange)
 * are tracked in an array and removed on cleanup to prevent leaks if
 * the component unmounts mid-flight (the async getRegistration().then()
 * is also guarded by an isMounted flag so setWaitingWorker isn't
 * called on an unmounted component).
 */
export function UpdatePrompt() {
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const activatedRef = useRef(false);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    let isMounted = true;
    // #33: track all listeners we add so cleanup can remove every one.
    const cleanups: Array<() => void> = [];

    const handleNewWaiter = (reg: ServiceWorkerRegistration) => {
      if (reg.waiting && isMounted) setWaitingWorker(reg.waiting);
    };

    navigator.serviceWorker
      .getRegistration('/sw.js')
      .then((reg) => {
        if (!reg || !isMounted) return;
        handleNewWaiter(reg);

        const onUpdateFound = () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          const onStateChange = () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // A new version is installed and the old one is controlling
              // the page → the new one is "waiting".
              handleNewWaiter(reg);
            }
          };
          newWorker.addEventListener('statechange', onStateChange);
          cleanups.push(() => newWorker.removeEventListener('statechange', onStateChange));
        };
        reg.addEventListener('updatefound', onUpdateFound);
        cleanups.push(() => reg.removeEventListener('updatefound', onUpdateFound));
      })
      .catch((err) => {
        if (isMounted) console.warn('[UpdatePrompt] getRegistration failed:', err);
      });

    // Reload ONLY when a new SW takes over after the user clicked
    // "تحديث" (activatedRef). On the first visit, `clients.claim()`
    // fires controllerchange with controller going null→SW; that is
    // not a user-initiated update, so we skip the reload.
    const onControllerChange = () => {
      if (!activatedRef.current) return;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    cleanups.push(() =>
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
    );

    return () => {
      isMounted = false;
      // #33: remove every listener we added (controllerchange, updatefound,
      // and each per-worker statechange) so nothing leaks on unmount.
      cleanups.forEach((fn) => fn());
    };
  }, []);

  const handleActivate = () => {
    if (!waitingWorker) return;
    // Mark that the next controllerchange is user-initiated so the
    // reload guard above lets it through.
    activatedRef.current = true;
    waitingWorker.postMessage('SKIP_WAITING');
    // The `controllerchange` listener above will reload once the new
    // SW takes over.
  };

  if (!waitingWorker || dismissed) return null;

  return (
    <div
      dir="rtl"
      className="fixed bottom-20 sm:bottom-6 left-1/2 -translate-x-1/2 z-[60] max-w-[92%] sm:max-w-md bg-slate-900 text-white rounded-[16px] shadow-lg px-4 py-3 flex items-center gap-3 border border-slate-800"
      role="status"
      aria-live="polite"
    >
      <div className="w-8 h-8 rounded-full bg-teal-500/20 text-teal-300 flex items-center justify-center shrink-0">
        <RefreshCw className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-bold text-slate-100">تحديث جديد متاح</div>
        <div className="text-[11px] text-slate-300 leading-snug">
          اضغط لتفعيل التحديث وإعادة التحميل.
        </div>
      </div>
      <button
        type="button"
        onClick={handleActivate}
        className="px-3.5 py-1.5 rounded-full bg-teal-500 hover:bg-teal-400 text-slate-950 text-xs font-bold transition active:scale-95 shrink-0 cursor-pointer"
      >
        تحديث
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-800 transition shrink-0 cursor-pointer"
        aria-label="إغلاق"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
