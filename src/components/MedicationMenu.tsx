import { useState } from 'react';
import {
  MoreVertical,
  Edit3,
  Trash2,
  PauseCircle,
  PlayCircle,
} from 'lucide-react';
import { Medication } from '../types';

/**
 * The per-card dropdown menu shared by the three MedicationCard
 * render branches (alerts / sufficient / all).
 *
 * The refill option was removed at the user's request — refills are
 * handled exclusively via the dedicated card action buttons.
 */
interface MedicationMenuProps {
  medication: Medication;
  isAutoActive: boolean;
  showRefillInMenu?: boolean;
  onOpenRefill?: (medication: Medication) => void;
  onEdit: (medication: Medication) => void;
  onDelete: (id: string) => void;
  onToggleAutoDeduct: (id: string) => void;
}

export function MedicationMenu({
  medication,
  isAutoActive,
  onEdit,
  onDelete,
  onToggleAutoDeduct,
}: MedicationMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setMenuOpen(!menuOpen)}
        className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
        aria-label="خيارات"
      >
        <MoreVertical className="w-4 h-4" />
      </button>

      {menuOpen && (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={() => setMenuOpen(false)}
          />
          <div className="absolute left-0 top-8 z-30 w-44 bg-white border border-slate-200 rounded-xl shadow-xl py-1 text-xs">
            <button
              onClick={() => {
                setMenuOpen(false);
                onEdit(medication);
              }}
              className="w-full text-right px-3 py-2 text-slate-700 hover:bg-slate-50 flex items-center gap-2"
            >
              <Edit3 className="w-3.5 h-3.5 text-slate-500" />
              <span>تعديل تفاصيل الدواء</span>
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                onToggleAutoDeduct(medication.id);
              }}
              className="w-full text-right px-3 py-2 text-slate-700 hover:bg-slate-50 flex items-center gap-2"
            >
              {isAutoActive ? (
                <>
                  <PauseCircle className="w-3.5 h-3.5 text-amber-600" />
                  <span>إيقاف الخصم التلقائي مؤقتاً</span>
                </>
              ) : (
                <>
                  <PlayCircle className="w-3.5 h-3.5 text-emerald-600" />
                  <span>تفعيل الخصم التلقائي</span>
                </>
              )}
            </button>
            <hr className="my-1 border-slate-100" />
            <button
              onClick={() => {
                setMenuOpen(false);
                onDelete(medication.id);
              }}
              className="w-full text-right px-3 py-2 text-rose-600 hover:bg-rose-50 flex items-center gap-2"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>حذف الدواء</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
