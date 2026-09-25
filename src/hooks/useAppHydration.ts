import { useEffect, useRef } from 'react';
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
  const {
    setMedications,
    setLogs,
    setPharmacySettings,
    setHydrated,
    setIsFirstRun,
    setIsAutoDeductPromptOpen,
    setSoundEnabled,
    setNotificationsEnabled,
    setCriticalStockAlertsEnabled,
    setExactAlarmPermission,
    setGlobalAutoDeductEnabled,
    setFontScale,
    setIsCompactView,
  } = setters;

  const hydrationStartedRef = useRef(false);

  useEffect(() => {
    if (hydrationStartedRef.current) return;
    hydrationStartedRef.current = true;

    const persistedState = loadPersistedAppState({
      setLogs,
      setPharmacySettings,
      setIsFirstRun,
      setSoundEnabled,
      setNotificationsEnabled,
      setCriticalStockAlertsEnabled,
      setGlobalAutoDeductEnabled,
      setFontScale,
      setIsCompactView,
    });

    Promise.all([
      initializeAppPermissions({
        setNotificationsEnabled,
        setExactAlarmPermission,
      }),
      initializeNativeRuntime(setNotificationsEnabled).catch((err) => {
        console.warn('[App] Native bridge init failed:', err);
      }),
    ])
      .then(() => convergeHydratedStock(persistedState, setMedications))
      .catch((err) => {
        // Keep the coordinator fault-tolerant if a future phase ever adds an
        // uncaught failure; readiness still follows the existing contract.
        console.warn('[App] App hydration phase failed:', err);
      })
      .finally(() => {
        publishHydrationReadiness(
          setHydrated,
          persistedState.shouldShowAutoDeductPrompt,
          setIsAutoDeductPromptOpen
        );
      });
  }, [
    setMedications,
    setLogs,
    setPharmacySettings,
    setHydrated,
    setIsFirstRun,
    setIsAutoDeductPromptOpen,
    setSoundEnabled,
    setNotificationsEnabled,
    setCriticalStockAlertsEnabled,
    setExactAlarmPermission,
    setGlobalAutoDeductEnabled,
    setFontScale,
    setIsCompactView,
  ]);
}
