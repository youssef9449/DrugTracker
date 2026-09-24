import { useEffect } from 'react';
import type { AppHydrationPhaseSetters } from '../utils/appHydrationPhases';
import {
  loadPersistedAppState,
  initializeAppPermissions,
  initializeNativeRuntime,
  convergeHydratedStock,
  publishHydrationReadiness,
} from '../utils/appHydrationPhases';

export type AppHydrationSetters = AppHydrationPhaseSetters;

/**
 * Client-side hydration coordinator.
 *
 * Ordering is intentional and must be preserved:
 * 1. persisted-state loading;
 * 2. notification/exact-alarm capability initialization and native runtime
 *    initialization start concurrently;
 * 3. Native Auto stock convergence;
 * 4. readiness publication.
 *
 * Each phase owns one responsibility; this hook only coordinates their order.
 */
export function useAppHydration(setters: AppHydrationSetters): void {
  useEffect(() => {
    const persistedState = loadPersistedAppState(setters);

    Promise.all([
      initializeAppPermissions(setters),
      initializeNativeRuntime(setters.setNotificationsEnabled).catch((err) => {
        console.warn('[App] Native bridge init failed:', err);
      }),
    ])
      .then(() => convergeHydratedStock(persistedState, setters.setMedications))
      .catch((err) => {
        // Keep the coordinator fault-tolerant if a future phase ever adds an
        // uncaught failure; readiness still follows the existing contract.
        console.warn('[App] App hydration phase failed:', err);
      })
      .finally(() => {
        publishHydrationReadiness(
          setters.setHydrated,
          persistedState.shouldShowAutoDeductPrompt,
          setters.setIsAutoDeductPromptOpen
        );
      });
  }, [setters]);
}
