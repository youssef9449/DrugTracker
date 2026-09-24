import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Medication } from '../types';
import type { OrderItem } from '../utils/whatsapp';
import { TOAST_DURATION_MS } from '../utils/time';
import { getInitialTab } from '../lib/initialTab';
import type { ActiveTab } from '../components/AndroidBottomNav';
import type { MedicationSortField, MedicationSortDirection } from '../utils/medicationSorting';

export type SettingsModalMode = 'all' | 'pharmacy';
export type AppFilter = 'all' | 'alerts' | 'sufficient';

export interface AppUiState {
  activeTab: ActiveTab;
  filter: AppFilter;
  searchQuery: string;
  isAddModalOpen: boolean;
  isSettingsModalOpen: boolean;
  settingsModalMode: SettingsModalMode;
  activeOrderItems: OrderItem[] | undefined;
  editingMedication: Medication | null;
  refillMedication: Medication | null;
  selectDoseMed: Medication | null;
  selectDoseMode: 'take' | 'restore' | 'manage';
  historyMedication: Medication | null;
  isPhoneFrame: boolean;
  medicationSortField: MedicationSortField;
  medicationSortDirection: MedicationSortDirection;
  toast: { id: number; message: string } | null;
  setActiveTab: Dispatch<SetStateAction<ActiveTab>>;
  setFilter: Dispatch<SetStateAction<AppFilter>>;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  setIsAddModalOpen: Dispatch<SetStateAction<boolean>>;
  setIsSettingsModalOpen: Dispatch<SetStateAction<boolean>>;
  setSettingsModalMode: Dispatch<SetStateAction<SettingsModalMode>>;
  setActiveOrderItems: Dispatch<SetStateAction<OrderItem[] | undefined>>;
  setEditingMedication: Dispatch<SetStateAction<Medication | null>>;
  setRefillMedication: Dispatch<SetStateAction<Medication | null>>;
  setSelectDoseMed: Dispatch<SetStateAction<Medication | null>>;
  setSelectDoseMode: Dispatch<SetStateAction<'take' | 'restore' | 'manage'>>;
  setHistoryMedication: Dispatch<SetStateAction<Medication | null>>;
  setIsPhoneFrame: Dispatch<SetStateAction<boolean>>;
  setMedicationSortField: Dispatch<SetStateAction<MedicationSortField>>;
  setMedicationSortDirection: Dispatch<SetStateAction<MedicationSortDirection>>;
  showToast: (message: string) => void;
}

export function useAppUiState(): AppUiState {
  const [activeTab, setActiveTab] = useState<ActiveTab>(getInitialTab);
  const [filter, setFilter] = useState<AppFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [settingsModalMode, setSettingsModalMode] = useState<SettingsModalMode>('all');
  const [activeOrderItems, setActiveOrderItems] = useState<OrderItem[] | undefined>();
  const [editingMedication, setEditingMedication] = useState<Medication | null>(null);
  const [refillMedication, setRefillMedication] = useState<Medication | null>(null);
  const [selectDoseMed, setSelectDoseMed] = useState<Medication | null>(null);
  const [selectDoseMode, setSelectDoseMode] = useState<'take' | 'restore' | 'manage'>('take');
  const [historyMedication, setHistoryMedication] = useState<Medication | null>(null);
  const [isPhoneFrame, setIsPhoneFrame] = useState(true);
  const [medicationSortField, setMedicationSortField] = useState<MedicationSortField>('name');
  const [medicationSortDirection, setMedicationSortDirection] = useState<MedicationSortDirection>('asc');
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastIdRef = useRef(0);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
    };
  }, []);

  const showToast = useCallback((message: string) => {
    const id = ++toastIdRef.current;
    setToast({ id, message });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      setToast((current) => (current?.id === id ? null : current));
      toastTimerRef.current = null;
    }, TOAST_DURATION_MS);
  }, []);

  return {
    activeTab, filter, searchQuery, isAddModalOpen, isSettingsModalOpen, settingsModalMode,
    activeOrderItems, editingMedication, refillMedication, selectDoseMed, selectDoseMode,
    historyMedication, isPhoneFrame, medicationSortField, medicationSortDirection, toast,
    setActiveTab, setFilter, setSearchQuery, setIsAddModalOpen, setIsSettingsModalOpen,
    setSettingsModalMode, setActiveOrderItems, setEditingMedication, setRefillMedication,
    setSelectDoseMed, setSelectDoseMode, setHistoryMedication, setIsPhoneFrame,
    setMedicationSortField, setMedicationSortDirection, showToast,
  };
}
