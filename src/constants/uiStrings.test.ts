import { describe, it, expect } from 'vitest';
import { TOAST_MESSAGES, PERSIST_FAILURE_MESSAGES, STORAGE_ERRORS } from './uiStrings';

describe('uiStrings (#100)', () => {
  it('TOAST_MESSAGES.doseTaken formats with name + amount + unit', () => {
    expect(TOAST_MESSAGES.doseTaken('كونكور', 1, 'قرص')).toBe(
      'تم تسجيل جرعة "كونكور" (-1 قرص). لن يتم الخصم التلقائي اليوم.'
    );
  });

  it('TOAST_MESSAGES.doseAlreadyTaken formats with name', () => {
    expect(TOAST_MESSAGES.doseAlreadyTaken('جلوكوفاج')).toBe(
      'تم تناول جرعة "جلوكوفاج" اليوم بالفعل.'
    );
  });

  it('TOAST_MESSAGES.refillUndone formats with name', () => {
    expect(TOAST_MESSAGES.refillUndone('فيتامين د')).toBe(
      'تم التراجع عن تعبئة "فيتامين د".'
    );
  });

  it('TOAST_MESSAGES.criticalAlertsOn is a non-empty string', () => {
    expect(TOAST_MESSAGES.criticalAlertsOn.length).toBeGreaterThan(10);
    expect(TOAST_MESSAGES.criticalAlertsOn).toContain('تنبيهات النفاذ الحرج');
  });

  it('TOAST_MESSAGES.criticalAlertsOff is a non-empty string', () => {
    expect(TOAST_MESSAGES.criticalAlertsOff).toContain('إيقاف');
  });

  it('TOAST_MESSAGES.autoDeductSummary formats with totalPills', () => {
    expect(TOAST_MESSAGES.autoDeductSummary(5)).toBe(
      'تم الخصم التلقائي للاستهلاك: خصم 5 قرص لمرور الأيام.'
    );
  });

  it('PERSIST_FAILURE_MESSAGES has all 7 keys', () => {
    expect(Object.keys(PERSIST_FAILURE_MESSAGES)).toHaveLength(7);
    expect(PERSIST_FAILURE_MESSAGES.meds).toContain('الأدوية');
    expect(PERSIST_FAILURE_MESSAGES.notifications).toContain('التنبيهات');
  });

  it('STORAGE_ERRORS has quota + generic', () => {
    expect(STORAGE_ERRORS.quotaExceeded).toBe('مساحة التخزين ممتلئة');
    expect(STORAGE_ERRORS.generic).toBe('تعذّر حفظ البيانات');
  });
});
