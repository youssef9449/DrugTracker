import { useCallback, useEffect, useRef } from 'react';
import type { ActiveTab } from '../components/AndroidBottomNav';
import { registerBackButtonHandler } from '../native';

export type BackOverlayRegistration = (
  id: string,
  close: () => void,
  priority?: number
) => () => void;

type OverlayEntry = {
  id: string;
  close: () => void;
  priority: number;
  order: number;
};

const MAX_NAVIGATION_HISTORY = 30;

export function useAppBackNavigation(
  activeTab: ActiveTab,
  setActiveTab: React.Dispatch<React.SetStateAction<ActiveTab>>
): {
  navigateToTab: (tab: ActiveTab) => void;
  registerBackOverlay: BackOverlayRegistration;
} {
  const overlaysRef = useRef(new Map<string, OverlayEntry>());
  const overlayOrderRef = useRef(0);
  const historyRef = useRef<ActiveTab[]>([]);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const navigateToTab = useCallback((tab: ActiveTab) => {
    const current = activeTabRef.current;
    if (current === tab) return;
    historyRef.current = [...historyRef.current, current].slice(-MAX_NAVIGATION_HISTORY);
    activeTabRef.current = tab;
    setActiveTab(tab);
  }, [setActiveTab]);

  const registerBackOverlay = useCallback<BackOverlayRegistration>(
    (id, close, priority = 0) => {
      const order = ++overlayOrderRef.current;
      overlaysRef.current.set(id, { id, close, priority, order });
      return () => {
        const current = overlaysRef.current.get(id);
        if (current?.order === order) {
          overlaysRef.current.delete(id);
        }
      };
    },
    []
  );

  useEffect(() => {
    registerBackButtonHandler(() => {
      const activeOverlays = [...overlaysRef.current.values()];
      if (activeOverlays.length > 0) {
        activeOverlays.sort((a, b) => a.priority - b.priority || a.order - b.order);
        activeOverlays[activeOverlays.length - 1].close();
        return true;
      }

      const previousTab = historyRef.current.pop();
      if (previousTab != null) {
        activeTabRef.current = previousTab;
        setActiveTab(previousTab);
        return true;
      }

      return false;
    });
  }, [setActiveTab]);

  return { navigateToTab, registerBackOverlay };
}
