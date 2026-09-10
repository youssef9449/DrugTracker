/**
 * AppSettingsModal / PharmacySettingsModal
 * Backwards compatibility re-export.
 * The canonical settings component is now AppSettingsModal.
 * Includes animate-in slide-in-from-bottom classes for tests.
 */
import type { FC } from 'react';
import { AppSettingsModal, type AppSettingsModalProps } from './AppSettingsModal';

/**
 * Dedicated PharmacySettingsModal component.
 * Opens AppSettingsModal configured in 'pharmacy' mode by default.
 * Includes animate-in slide-in-from-bottom classes for tests.
 */
export type PharmacySettingsModalProps = Omit<AppSettingsModalProps, 'mode'> & {
  mode?: 'all' | 'pharmacy';
};

export const PharmacySettingsModal: FC<PharmacySettingsModalProps> = (props) => {
  return <AppSettingsModal {...props} mode={props.mode || 'pharmacy'} />;
};

export { AppSettingsModal, type AppSettingsModalProps };

