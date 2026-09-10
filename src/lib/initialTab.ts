import type { ActiveTab } from '../components/AndroidBottomNav';

/**
 * #17: read the `tab` query param from the URL on mount so the PWA
 * manifest shortcuts (/?tab=stock, /?tab=logs, /?tab=shopping) land on
 * the correct tab. Defaults to 'stock' if the param is missing or
 * invalid.
 *
 * Exported for unit testing (the App component calls this as its
 * useState initializer).
 *
 * #103: this function is intentionally in its own file (rather than
 * co-located with `ActiveTab` + `TABS` in AndroidBottomNav.tsx) so the
 * co-located test (`initialTab.test.ts`, 7 tests) can import it without
 * pulling in React / lucide-react / the full AndroidBottomNav component
 * graph. This keeps the test lightweight (no jsdom-React render cost)
 * and isolates the URL-parsing logic from the presentational component.
 */
export function getInitialTab(): ActiveTab {
  if (typeof window === 'undefined') return 'stock';
  const tab = new URLSearchParams(window.location.search).get('tab');
  if (tab === 'shopping' || tab === 'logs' || tab === 'stock') return tab;
  return 'stock';
}
