import type { Medication, MedicationDose } from '../types';
import { isSolidUnit } from '../utils/medicationPackaging';
import {
  getDoseScheduleForUI,
  resizeDoseSchedule,
} from '../utils/doseSchedule';
import { calculateStripBasedPackageSize } from '../utils/addMedicationFormCalculations';

export interface AddMedicationFormModel {
  details: { name: string; category: string; colorTag: string; unit: string };
  stock: {
    currentPills: number;
    currentPillsStr: string;
    packageSize: number;
    packageSizeStr: string;
  };
  packaging: {
    stripsPerBox: string;
    pillsPerStrip: string;
    noStrips: boolean;
    showStockHelper: boolean;
    helperBoxes: string;
    helperStrips: string;
    helperLoose: string;
  };
  dosage: {
    dosesPerDay: number;
    doseSchedule: MedicationDose[];
    warningThresholdDays: string;
    criticalStockAlertsEnabled: boolean;
  };
  treatment: {
    isChronic: boolean;
    durationDaysStr: string;
    treatmentStartDateStr: string;
    reminderEnabled: boolean;
    autoDeductEnabled: boolean;
  };
  ui: { error: string };
}

export type AddMedicationFormAction =
  | { type: 'RESET_ADD'; defaultAutoDeductEnabled: boolean }
  | { type: 'INIT_EDIT'; medication: Medication }
  | { type: 'SET_NAME'; value: string }
  | { type: 'SET_CATEGORY'; value: string }
  | { type: 'SET_COLOR_TAG'; value: string }
  | { type: 'SET_UNIT'; value: string }
  | { type: 'SET_CURRENT_PILLS'; value: number }
  | { type: 'SET_CURRENT_PILLS_STR'; value: string }
  | { type: 'SET_PACKAGE_SIZE'; value: number }
  | { type: 'SET_PACKAGE_SIZE_STR'; value: string }
  | { type: 'SET_STRIPS_PER_BOX'; value: string }
  | { type: 'SET_PILLS_PER_STRIP'; value: string }
  | { type: 'SET_NO_STRIPS'; value: boolean }
  | { type: 'SET_SHOW_STOCK_HELPER'; value: boolean }
  | { type: 'SET_HELPER_BOXES'; value: string }
  | { type: 'SET_HELPER_STRIPS'; value: string }
  | { type: 'SET_HELPER_LOOSE'; value: string }
  | { type: 'APPLY_STOCK_HELPER'; total: number }
  | { type: 'SET_DOSES_PER_DAY'; value: number }
  | { type: 'SET_DOSE_SCHEDULE'; value: MedicationDose[] }
  | { type: 'SET_WARNING_THRESHOLD_DAYS'; value: string }
  | { type: 'SET_CRITICAL_STOCK_ALERTS_ENABLED'; value: boolean }
  | { type: 'SET_IS_CHRONIC'; value: boolean }
  | { type: 'SET_DURATION_DAYS_STR'; value: string }
  | { type: 'SET_TREATMENT_START_DATE_STR'; value: string }
  | { type: 'SET_REMINDER_ENABLED'; value: boolean }
  | { type: 'SET_AUTO_DEDUCT_ENABLED'; value: boolean }
  | { type: 'SET_ERROR'; value: string }
  | { type: 'UNIT_CHANGED'; nextUnit: string; skipDefaults?: boolean }
  | { type: 'STRIPS_CHANGED'; value: string }
  | { type: 'PILLS_PER_STRIP_CHANGED'; value: string };

export function createDefaultFormModel(
  defaultAutoDeductEnabled = false
): AddMedicationFormModel {
  const defaultSchedule = resizeDoseSchedule([], 1);
  return {
    details: { name: '', category: '', colorTag: 'teal', unit: 'قرص' },
    stock: {
      currentPills: 30,
      currentPillsStr: '30',
      packageSize: 30,
      packageSizeStr: '30',
    },
    packaging: {
      stripsPerBox: '3',
      pillsPerStrip: '10',
      noStrips: false,
      showStockHelper: false,
      helperBoxes: '1',
      helperStrips: '0',
      helperLoose: '0',
    },
    dosage: {
      dosesPerDay: 1,
      doseSchedule: defaultSchedule,
      warningThresholdDays: '5',
      criticalStockAlertsEnabled: false,
    },
    treatment: {
      isChronic: true,
      durationDaysStr: '',
      treatmentStartDateStr: '',
      reminderEnabled: false,
      autoDeductEnabled: defaultAutoDeductEnabled,
    },
    ui: { error: '' },
  };
}

export function createEditFormModel(medication: Medication): AddMedicationFormModel {
  const schedule = getDoseScheduleForUI(medication);
  const initUnit = medication.unit || 'قرص';
  const isSolid = isSolidUnit(initUnit);
  const hasStrips =
    isSolid &&
    Boolean(
      medication.stripsPerBox &&
        medication.pillsPerStrip &&
        medication.stripsPerBox > 0 &&
        medication.pillsPerStrip > 0
    );
  const defaultPkg = isSolid ? 30 : initUnit === 'مل' ? 100 : 30;
  let stripsPerBox: string;
  let pillsPerStrip: string;
  let packageSize: number;
  if (hasStrips) {
    const strips = medication.stripsPerBox!;
    const perStrip = medication.pillsPerStrip!;
    stripsPerBox = String(strips);
    pillsPerStrip = String(perStrip);
    packageSize =
      medication.packageSize || (strips && perStrip ? strips * perStrip : 30);
  } else {
    stripsPerBox = String(medication.packageSize || defaultPkg);
    pillsPerStrip = String(medication.pillsPerStrip || 10);
    packageSize = medication.packageSize || defaultPkg;
  }
  return {
    details: {
      name: medication.name,
      category: medication.category || '',
      colorTag: medication.colorTag || 'teal',
      unit: initUnit,
    },
    stock: {
      currentPills: medication.currentPills,
      currentPillsStr: String(medication.currentPills),
      packageSize,
      packageSizeStr: String(packageSize),
    },
    packaging: {
      stripsPerBox,
      pillsPerStrip,
      noStrips: !hasStrips,
      showStockHelper: false,
      helperBoxes: '1',
      helperStrips: '0',
      helperLoose: '0',
    },
    dosage: {
      dosesPerDay: schedule.length,
      doseSchedule: schedule,
      warningThresholdDays: String(medication.warningThresholdDays ?? 5),
      criticalStockAlertsEnabled: medication.criticalStockAlertsEnabled !== false,
    },
    treatment: {
      isChronic: medication.isChronic !== false,
      durationDaysStr:
        medication.isChronic === false && medication.durationDays
          ? String(medication.durationDays)
          : '',
      treatmentStartDateStr:
        medication.isChronic === false
          ? medication.treatmentStartDate ?? ''
          : '',
      reminderEnabled: Boolean(medication.reminderEnabled),
      autoDeductEnabled: medication.autoDeductEnabled === true,
    },
    ui: { error: '' },
  };
}

function withPackageFromStrips(
  state: AddMedicationFormModel,
  stripsPerBox: string,
  pillsPerStrip: string
): AddMedicationFormModel {
  const pkg = calculateStripBasedPackageSize(stripsPerBox, pillsPerStrip);
  return {
    ...state,
    packaging: { ...state.packaging, stripsPerBox, pillsPerStrip },
    stock: {
      ...state.stock,
      packageSize: pkg,
      // Original handlers only updated packageSize number; keep str in sync.
      packageSizeStr: String(pkg),
    },
  };
}

export function addMedicationFormReducer(
  state: AddMedicationFormModel,
  action: AddMedicationFormAction
): AddMedicationFormModel {
  switch (action.type) {
    case 'RESET_ADD':
      return createDefaultFormModel(action.defaultAutoDeductEnabled);
    case 'INIT_EDIT':
      return createEditFormModel(action.medication);
    case 'SET_NAME':
      return { ...state, details: { ...state.details, name: action.value } };
    case 'SET_CATEGORY':
      return { ...state, details: { ...state.details, category: action.value } };
    case 'SET_COLOR_TAG':
      return { ...state, details: { ...state.details, colorTag: action.value } };
    case 'SET_UNIT':
      return { ...state, details: { ...state.details, unit: action.value } };
    case 'SET_CURRENT_PILLS':
      return {
        ...state,
        stock: {
          ...state.stock,
          currentPills: action.value,
          currentPillsStr: String(action.value),
        },
      };
    case 'SET_CURRENT_PILLS_STR':
      return {
        ...state,
        stock: { ...state.stock, currentPillsStr: action.value },
      };
    case 'SET_PACKAGE_SIZE':
      return {
        ...state,
        stock: {
          ...state.stock,
          packageSize: action.value,
          packageSizeStr: String(action.value),
        },
      };
    case 'SET_PACKAGE_SIZE_STR':
      return {
        ...state,
        stock: { ...state.stock, packageSizeStr: action.value },
      };
    case 'SET_STRIPS_PER_BOX':
      return {
        ...state,
        packaging: { ...state.packaging, stripsPerBox: action.value },
      };
    case 'SET_PILLS_PER_STRIP':
      return {
        ...state,
        packaging: { ...state.packaging, pillsPerStrip: action.value },
      };
    case 'SET_NO_STRIPS':
      return {
        ...state,
        packaging: { ...state.packaging, noStrips: action.value },
      };
    case 'SET_SHOW_STOCK_HELPER':
      return {
        ...state,
        packaging: { ...state.packaging, showStockHelper: action.value },
      };
    case 'SET_HELPER_BOXES':
      return {
        ...state,
        packaging: { ...state.packaging, helperBoxes: action.value },
      };
    case 'SET_HELPER_STRIPS':
      return {
        ...state,
        packaging: { ...state.packaging, helperStrips: action.value },
      };
    case 'SET_HELPER_LOOSE':
      return {
        ...state,
        packaging: { ...state.packaging, helperLoose: action.value },
      };
    case 'APPLY_STOCK_HELPER':
      return {
        ...state,
        stock: {
          ...state.stock,
          currentPills: action.total,
          currentPillsStr: String(action.total),
        },
        packaging: { ...state.packaging, showStockHelper: false },
      };
    case 'SET_DOSES_PER_DAY':
      return {
        ...state,
        dosage: {
          ...state.dosage,
          dosesPerDay: action.value,
          doseSchedule: resizeDoseSchedule(state.dosage.doseSchedule, action.value),
        },
      };
    case 'SET_DOSE_SCHEDULE':
      return {
        ...state,
        dosage: {
          ...state.dosage,
          doseSchedule: action.value,
          dosesPerDay: action.value.length,
        },
      };
    case 'SET_WARNING_THRESHOLD_DAYS':
      return {
        ...state,
        dosage: { ...state.dosage, warningThresholdDays: action.value },
      };
    case 'SET_CRITICAL_STOCK_ALERTS_ENABLED':
      return {
        ...state,
        dosage: {
          ...state.dosage,
          criticalStockAlertsEnabled: action.value,
        },
      };
    case 'SET_IS_CHRONIC':
      return {
        ...state,
        treatment: {
          ...state.treatment,
          isChronic: action.value,
          durationDaysStr: action.value ? '' : state.treatment.durationDaysStr,
          treatmentStartDateStr: action.value
            ? ''
            : state.treatment.treatmentStartDateStr,
        },
      };
    case 'SET_DURATION_DAYS_STR':
      return {
        ...state,
        treatment: { ...state.treatment, durationDaysStr: action.value },
      };
    case 'SET_TREATMENT_START_DATE_STR':
      return {
        ...state,
        treatment: { ...state.treatment, treatmentStartDateStr: action.value },
      };
    case 'SET_REMINDER_ENABLED':
      return {
        ...state,
        treatment: { ...state.treatment, reminderEnabled: action.value },
      };
    case 'SET_AUTO_DEDUCT_ENABLED':
      return {
        ...state,
        treatment: { ...state.treatment, autoDeductEnabled: action.value },
      };
    case 'SET_ERROR':
      return { ...state, ui: { error: action.value } };
    case 'UNIT_CHANGED': {
      const nextUnit = action.nextUnit;
      let next = {
        ...state,
        details: { ...state.details, unit: nextUnit },
      };
      // Match prior add-mode unit transition defaults only (edit mode skips).
      if (action.skipDefaults) {
        return next;
      }
      if (nextUnit === 'مل') {
        if (next.stock.packageSize === 30) {
          next = {
            ...next,
            stock: { ...next.stock, packageSize: 100, packageSizeStr: '100' },
          };
        }
        if (next.stock.currentPills === 30) {
          next = {
            ...next,
            stock: {
              ...next.stock,
              currentPills: 100,
              currentPillsStr: '100',
            },
          };
        }
        const onlyDose = next.dosage.doseSchedule[0];
        if (onlyDose && next.dosage.doseSchedule.length === 1 && Number(onlyDose.amount) === 1) {
          next = {
            ...next,
            dosage: {
              ...next.dosage,
              doseSchedule: [{ ...onlyDose, amount: 5 }],
            },
          };
        }
      } else if (isSolidUnit(nextUnit)) {
        if (next.stock.packageSize === 100) {
          next = {
            ...next,
            stock: { ...next.stock, packageSize: 30, packageSizeStr: '30' },
          };
        }
        if (next.stock.currentPills === 100) {
          next = {
            ...next,
            stock: {
              ...next.stock,
              currentPills: 30,
              currentPillsStr: '30',
            },
          };
        }
        const onlyDose = next.dosage.doseSchedule[0];
        if (onlyDose && next.dosage.doseSchedule.length === 1 && Number(onlyDose.amount) === 5) {
          next = {
            ...next,
            dosage: {
              ...next.dosage,
              doseSchedule: [{ ...onlyDose, amount: 1 }],
            },
          };
        }
      }
      return next;
    }
    case 'STRIPS_CHANGED':
      return withPackageFromStrips(state, action.value, state.packaging.pillsPerStrip);
    case 'PILLS_PER_STRIP_CHANGED':
      return withPackageFromStrips(state, state.packaging.stripsPerBox, action.value);
    default:
      return state;
  }
}
