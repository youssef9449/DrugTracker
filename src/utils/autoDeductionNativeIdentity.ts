export function autoDeductionOccurrenceKey(
  medicationId: string,
  doseId: string,
  calendarDate: string
): string {
  return `${medicationId}\u001f${doseId}\u001f${calendarDate}`;
}
