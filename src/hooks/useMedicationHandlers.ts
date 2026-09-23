import type { MedicationHandlersDeps } from './medicationHandlerTypes';
import { useMedicationHandlerState } from './useMedicationHandlerState';
import { useMedicationStockHandlers } from './useMedicationStockHandlers';
import { useMedicationCrudHandlers } from './useMedicationCrudHandlers';
import { useMedicationAutoHandlers } from './useMedicationAutoHandlers';
import { useMedicationAlarmHandlers } from './useMedicationAlarmHandlers';
import { useMedicationNotificationHandlers } from './useMedicationNotificationHandlers';

export type { MedicationHandlersDeps } from './medicationHandlerTypes';

export function useMedicationHandlers(deps: MedicationHandlersDeps) {
  const state = useMedicationHandlerState(
    deps.medications,
    deps.selectDoseMode,
    deps.globalAutoDeductEnabled
  );
  const stock = useMedicationStockHandlers(deps, state);
  const crud = useMedicationCrudHandlers(deps, state);
  const auto = useMedicationAutoHandlers(deps, state);
  const alarm = useMedicationAlarmHandlers(deps, state);
  const notifications = useMedicationNotificationHandlers(deps, state);

  return {
    ...stock,
    ...crud,
    ...auto,
    ...alarm,
    ...notifications,
  };
}
