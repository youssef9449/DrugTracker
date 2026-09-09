import type { ActiveTab } from '../components/AndroidBottomNav';

/**
 * #17: read the `tab` query param from the URL on mount so the PWA
 * manifest shortcuts (/?tab=stock, /?tab=logs, /?tab=shopping) land on
 * the correct tab. Defaults to 'stock' if the param is missing or
 * invalid.
 *
 * Exported for unit testing (the App component calls this as its
 * useState initializer).
 */
export function getInitialTab(): ActiveTab {
  if (typeof window === 'undefined') return 'stock';
  const tab = new URLSearchParams(window.location.search).get('tab');
  if (tab === 'shopping' || tab === 'logs' || tab === 'stock') return tab;
  return 'stock';
}
