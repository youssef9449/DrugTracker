import type { Medication } from '../types';

/**
 * Drop doseConsumptionHistory entries whose doseId is no longer on the schedule.
 * Pure helper — same semantics for current per-dose history model.
 */
export function pruneDoseConsumption(
  medData: Omit<Medication, 'id' | 'createdAt'>,
  existing?: Medication
): Omit<Medication, 'id' | 'createdAt'> {
  const schedule = medData.doseSchedule;
  if (!Array.isArray(schedule) || schedule.length === 0) {
    return medData;
  }
  const valid = new Set(schedule.map((d) => d.id));
  const prevHist =
    medData.doseConsumptionHistory ?? existing?.doseConsumptionHistory;
  let changed = false;
  let nextHist = prevHist;
  if (prevHist) {
    nextHist = {};
    for (const [id, dates] of Object.entries(prevHist)) {
      if (valid.has(id)) nextHist[id] = dates;
      else changed = true;
    }
  }
  // Also prune doseSkippedHistory if present
  const prevSkip =
    (medData as Medication).doseSkippedHistory ?? existing?.doseSkippedHistory;
  let nextSkip = prevSkip;
  if (prevSkip) {
    nextSkip = {};
    for (const [id, dates] of Object.entries(prevSkip)) {
      if (valid.has(id)) nextSkip[id] = dates;
      else changed = true;
    }
  }
  if (!changed && nextHist === prevHist && nextSkip === prevSkip) return medData;
  return {
    ...medData,
    ...(nextHist ? { doseConsumptionHistory: nextHist } : {}),
    ...(nextSkip ? { doseSkippedHistory: nextSkip } : {}),
  };
}
