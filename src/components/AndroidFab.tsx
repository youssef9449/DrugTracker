import type { FC } from 'react';
import { Plus } from 'lucide-react';

interface AndroidFabProps {
  /** Called when the FAB is clicked. */
  onClick: () => void;
}

export const AndroidFab: FC<AndroidFabProps> = ({ onClick }) => {
  // Position: anchored to the bottom-left, raised above the
  // AndroidBottomNav (which sits at ~64px tall). Using bottom-[128px]
  // keeps the FAB clear of both the bottom-nav AND the consumption-log
  // "smart tool" hint that can appear at the top of the list, so the
  // "إضافة دواء جديد" button is always reachable without overlap.
  // Previously bottom-[82px] which sat too close to the bottom-nav
  // and felt cramped; bumping up 46px gives it more breathing room.
  return (
    <div className="absolute bottom-[104px] left-4 z-40 pointer-events-auto">
      <button
        type="button"
        onClick={onClick}
        id="add-medicine-fab"
        aria-label="إضافة دواء جديد"
        className="h-14 px-5 bg-m3-primary hover:bg-m3-primary/90 active:bg-m3-primary/80 text-m3-on-primary font-medium text-sm rounded-2xl shadow-md hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-m3-primary/40 transition-colors duration-200 flex items-center gap-2.5 cursor-pointer"
      >
        <Plus className="w-6 h-6 stroke-[2.25]" />
        <span className="font-semibold tracking-wide">إضافة دواء جديد</span>
      </button>
    </div>
  );
};
