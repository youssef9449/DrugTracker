import type { Medication } from '../types';

/**
 * Drop doseConsumption / history entries whose doseId is no longer on the schedule.
 * Pure helper extracted from App.tsx — same semantics.
 */
export function pruneDoseConsumption(
  medData: Omit<Medication, 'id' | 'createdAt'>,
  existing?: Medication
): Omit<Medication, 'id' | 'createdAt'> {
  const schedule = medData.doseSchedule;
  if (!Array.isArray(schedule) || schedule.length === 0) {
    // Legacy / cleared schedule: do not force-migrate doseConsumption.
    return medData;
  }
  const valid = new Set(schedule.map((d) => d.id));
  const prev = medData.doseConsumption ?? existing?.doseConsumption;
  const prevHist =
    medData.doseConsumptionHistory ?? existing?.doseConsumptionHistory;
  let changed = false;
  let next = prev;
  if (prev) {
    next = {};
    for (const [id, date] of Object.entries(prev)) {
      if (valid.has(id)) next[id] = date;
      else changed = true;
    }
    if (Object.keys(next).length !== Object.keys(prev).length) changed = true;
  }
  let nextHist = prevHist;
  if (prevHist) {
    nextHist = {};
    for (const [id, dates] of Object.entries(prevHist)) {
      if (valid.has(id)) nextHist[id] = dates;
      else changed = true;
    }
  }
  if (!changed && next === prev && nextHist === prevHist) return medData;
  return {
    ...medData,
    ...(next ? { doseConsumption: next } : {}),
    ...(nextHist ? { doseConsumptionHistory: nextHist } : {}),
  };
}
