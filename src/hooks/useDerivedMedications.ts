import { useMemo } from 'react';
import type { Medication, ConsumptionLog } from '../types';
import { calculateMedicationStatus } from '../utils/medicationStatus';
import { sortMedications, type MedicationSortDirection, type MedicationSortField } from '../utils/medicationSorting';
/**
 * Derived medication lists and counts used by the inventory UI.
 * Stock/status projection follows medication Auto only.
 */
export function useDerivedMedications(
  medications: Medication[],
  logs: ConsumptionLog[],
  filter: 'all' | 'alerts' | 'sufficient',
  searchQuery: string,
  sortField: MedicationSortField = 'name',
  sortDirection: MedicationSortDirection = 'asc'
) {
  const medicationsWithStatus = useMemo(
    () =>
      medications.map((med) => ({
        med,
        statusInfo: calculateMedicationStatus(med),
      })),
    [medications]
  );

  // #89: Precompute a Map<medId, lastRefillLog> so the per-card render
  // doesn't call logs.find() O(meds×logs) per render. Previously this was
  // an inline IIFE inside the MedicationCard.map.
  const lastRefillByMed = useMemo(() => {
    const map = new Map<string, ConsumptionLog>();
    for (const log of logs) {
      if (
        log.type === 'refill' &&
        log.amount > 0 &&
        !log.reversedAt
      ) {
        // logs are newest-first; keep the FIRST (latest) matching log per med.
        if (!map.has(log.medicationId)) {
          map.set(log.medicationId, log);
        }
      }
    }
    return map;
  }, [logs]);

  // Realtime search: filters on every keystroke (searchQuery updates immediately
  // from the controlled input onChange/onInput — no debounce).
  const filteredMedications = useMemo(() => {
    const qRaw = searchQuery.trim().toLowerCase();
    // Light Arabic normalization so typing أ/ا/إ still matches names stored with أ
    const normalizeAr = (s: string) =>
      s
        .toLowerCase()
        .replace(/[أإآٱ]/g, 'ا')
        .replace(/ة/g, 'ه')
        .replace(/ى/g, 'ي');
    const q = qRaw ? normalizeAr(qRaw) : '';
    return medicationsWithStatus.filter(({ med, statusInfo }) => {
      if (q) {
        const matchName = normalizeAr(med.name).includes(q);
        const matchCat = med.category ? normalizeAr(med.category).includes(q) : false;
        const matchNotes = med.notes ? normalizeAr(med.notes).includes(q) : false;
        if (!matchName && !matchCat && !matchNotes) return false;
      }
      const { status } = statusInfo;
      if (filter === 'alerts') return status === 'out_of_stock' || status === 'critical' || status === 'warning';
      if (filter === 'sufficient') return status === 'sufficient';
      return true;
    }).map(({ med }) => med);
  }, [medicationsWithStatus, searchQuery, filter]);

  const sortedMedications = useMemo(
    () => sortMedications(filteredMedications, sortField, sortDirection),
    [filteredMedications, sortField, sortDirection]
  );

  const alertsCount = useMemo(
    () => medicationsWithStatus.filter(({ statusInfo }) =>
      statusInfo.status === 'out_of_stock' ||
      statusInfo.status === 'critical' ||
      statusInfo.status === 'warning'
    ).length,
    [medicationsWithStatus]
  );

  const sufficientCount = useMemo(
    () => medicationsWithStatus.filter(({ statusInfo }) => statusInfo.status === 'sufficient').length,
    [medicationsWithStatus]
  );

  return {
    medicationsWithStatus,
    lastRefillByMed,
    filteredMedications: sortedMedications,
    alertsCount,
    sufficientCount,
  };
}
