import React from 'react';
import { Plus } from 'lucide-react';

interface AndroidFabProps {
  onOpenAddModal?: () => void;
  onClick?: () => void;
}

export const AndroidFab: React.FC<AndroidFabProps> = ({ onOpenAddModal, onClick }) => {
  const handleClick = () => {
    if (onOpenAddModal) {
      onOpenAddModal();
    } else if (onClick) {
      onClick();
    }
  };

  return (
    <div className="absolute bottom-[82px] left-4 z-40 pointer-events-auto">
      <button
        type="button"
        onClick={handleClick}
        id="add-medicine-fab"
        aria-label="إضافة دواء جديد"
        className="flex items-center gap-2 px-4 py-3 bg-teal-600 hover:bg-teal-700 active:scale-95 text-white font-bold text-xs sm:text-sm rounded-2xl shadow-xl hover:shadow-2xl transition-all duration-200 border border-teal-400/40 ring-2 ring-white/60"
      >
        <Plus className="w-5 h-5 stroke-[2.5]" />
        <span>إضافة دواء جديد</span>
      </button>
    </div>
  );
};

