import { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';

/**
 * "New version available" prompt for the service worker (M10).
 *
 * The SW (`public/sw.js`) installs a new version in the background but
 * does NOT `skipWaiting()` on its own — it waits for the page to send
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
 */
export function UpdatePrompt() {
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    let registration: ServiceWorkerRegistration | null = null;

    const handleNewWaiter = (reg: ServiceWorkerRegistration) => {
      if (reg.waiting) setWaitingWorker(reg.waiting);
    };

    navigator.serviceWorker
      .getRegistration('/sw.js')
      .then((reg) => {
        if (!reg) return;
        registration = reg;
        handleNewWaiter(reg);
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // A new version is installed and the old one is controlling
              // the page → the new one is "waiting".
              handleNewWaiter(reg);
            }
          });
        });
      })
      .catch((err) => {
        console.warn('[UpdatePrompt] getRegistration failed:', err);
      });

    // Also pick up the case where the user reloads the page while a
    // new SW is already waiting (the updatefound event won't fire then).
    const onControllerChange = () => {
      // The new SW just took control — reload to run the new app shell.
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      if (registration) {
        // removeEventListener with the same handler reference isn't
        // possible for inline closures; the registration is GC'd with
        // the component unmount so this is safe.
      }
    };
  }, []);

  const handleActivate = () => {
    if (!waitingWorker) return;
    waitingWorker.postMessage('SKIP_WAITING');
    // The `controllerchange` listener above will reload once the new
    // SW takes over.
  };

  if (!waitingWorker || dismissed) return null;

  return (
    <div
      dir="rtl"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] max-w-[92%] sm:max-w-md bg-slate-900 text-white rounded-2xl shadow-2xl px-4 py-3 flex items-center gap-3 border border-teal-700/40"
      role="status"
      aria-live="polite"
    >
      <div className="w-8 h-8 rounded-xl bg-teal-600/30 border border-teal-500/40 flex items-center justify-center shrink-0">
        <RefreshCw className="w-4 h-4 text-teal-300" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-bold">تحديث جديد متاح</div>
        <div className="text-[11px] text-slate-300 leading-snug">
          اضغط لتفعيل التحديث وإعادة التحميل.
        </div>
      </div>
      <button
        type="button"
        onClick={handleActivate}
        className="px-3 py-1.5 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold transition active:scale-95 shrink-0"
      >
        تحديث
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700/60 transition shrink-0"
        aria-label="إغلاق"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
