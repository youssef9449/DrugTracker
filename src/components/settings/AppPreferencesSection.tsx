import type { FC, Dispatch, SetStateAction } from 'react';
import { Zap, ZapOff, Volume2, VolumeX } from 'lucide-react';
import { Toggle } from '../ui/Toggle';

export interface AppPreferencesSectionProps {
  draftAutoDeduct: boolean;
  setDraftAutoDeduct: Dispatch<SetStateAction<boolean>>;
  draftSound: boolean;
  setDraftSound: Dispatch<SetStateAction<boolean>>;
}

/** App preference toggles: auto-deduct and sound. */
export const AppPreferencesSection: FC<AppPreferencesSectionProps> = ({
  draftAutoDeduct,
  setDraftAutoDeduct,
  draftSound,
  setDraftSound,
}) => (
  <>
    <div className="bg-teal-50/70 border border-teal-200/80 rounded-2xl p-3.5 space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className={`p-1.5 rounded-lg ${
              draftAutoDeduct
                ? 'bg-teal-600 text-white'
                : 'bg-amber-100 text-amber-600 border border-amber-300/60'
            }`}
          >
            {draftAutoDeduct ? (
              <Zap className="w-4 h-4" />
            ) : (
              <ZapOff className="w-4 h-4 text-amber-500" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-slate-800">الخصم التلقائي للمخزون</span>
              <span
                className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${
                  draftAutoDeduct ? 'bg-teal-200 text-teal-900' : 'bg-slate-200 text-slate-700'
                }`}
              >
                {draftAutoDeduct ? 'مفعّل' : 'متوقف'}
              </span>
            </div>
            <p className="text-[10px] text-slate-500 leading-tight">
              يُخصم تلقائياً عند ميعاد كل جرعة
            </p>
          </div>
        </div>
        <Toggle
          checked={draftAutoDeduct}
          onChange={() => setDraftAutoDeduct((v) => !v)}
          label="تبديل الخصم التلقائي"
        />
      </div>
      <p className="text-[10px] text-slate-500 leading-tight border-t border-teal-100/80 pt-2">
        {draftAutoDeduct
          ? 'عند التفعيل يُخصم عند ميعاد الجرعات ويُحدَّث الرصيد وموعد النفاذ.'
          : 'عند الإيقاف يتوقف الخصم التلقائي ويبقى الرصيد ثابتاً.'}
      </p>
    </div>
    <div className="bg-slate-50 border border-slate-200/80 rounded-2xl p-3.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className={`p-1.5 rounded-lg ${
              draftSound ? 'bg-teal-100 text-teal-700' : 'bg-slate-200 text-slate-500'
            }`}
          >
            {draftSound ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
          </div>
          <div>
            <span className="text-xs font-bold text-slate-800 block">صوت التطبيق</span>
            <p className="text-[10px] text-slate-500">نغمات النجاح والتنبيه داخل التطبيق</p>
          </div>
        </div>
        <Toggle
          checked={draftSound}
          onChange={() => setDraftSound((v) => !v)}
          label="تبديل صوت التطبيق"
        />
      </div>
    </div>
  </>
);
