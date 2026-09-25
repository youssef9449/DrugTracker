import type { FC } from 'react';
import {
  Bell,
  BellOff,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import type { ExactAlarmPermission } from '../../utils/exactAlarm';
import { Toggle } from '../ui/Toggle';

export interface NotificationSettingsSectionProps {
  draftNotifications: boolean;
  draftCritical: boolean;
  onToggleNotifications: () => void;
  onToggleCritical: () => void;
  exactAlarmPermission?: ExactAlarmPermission | null | undefined;
  onOpenExactAlarmSettings?: (() => void) | undefined;
  onSendTestNotification?: (() => void) | undefined;
}

/** Notification + critical-stock + exact-alarm settings workflow. */
export const NotificationSettingsSection: FC<NotificationSettingsSectionProps> = ({
  draftNotifications,
  draftCritical,
  onToggleNotifications,
  onToggleCritical,
  exactAlarmPermission = null,
  onOpenExactAlarmSettings,
  onSendTestNotification,
}) => (
  <div className="bg-slate-50 border border-slate-200/80 rounded-2xl p-3.5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div
                      className={`p-1.5 rounded-lg ${
                        draftNotifications ? 'bg-amber-100 text-amber-600' : 'bg-slate-200 text-slate-500'
                      }`}
                    >
                      {draftNotifications ? (
                        <Bell className="w-4 h-4 fill-amber-500" />
                      ) : (
                        <BellOff className="w-4 h-4" />
                      )}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-slate-800">تذكيرات مواعيد الجرعات</span>
                        <span
                          className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${
                            draftNotifications ? 'bg-amber-100 text-amber-900 border border-amber-300/50' : 'bg-slate-200 text-slate-700'
                          }`}
                        >
                          {draftNotifications ? 'مفعّلة' : 'متوقفة'}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-500">تذكيرات الجرعات في المواعيد المحددة فقط</p>
                    </div>
                  </div>
                  <Toggle
                    id="settings-toggle-notifications"
                    checked={draftNotifications}
                    onChange={onToggleNotifications}
                    label={
                      draftNotifications
                        ? 'تذكيرات مواعيد الجرعات مفعّلة — انقر للإيقاف'
                        : 'تذكيرات مواعيد الجرعات متوقفة — انقر للتفعيل'
                    }
                    color="amber"
                  />
                </div>
                <hr className="border-slate-200" />
                {/* Critical Stock Alerts Toggle */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div
                      className={`p-1.5 rounded-lg ${
                        draftCritical ? 'bg-rose-100 text-rose-600' : 'bg-slate-200 text-slate-500'
                      }`}
                    >
                      <AlertTriangle
                        className={`w-4 h-4 ${
                          draftCritical ? 'fill-rose-500/30' : ''
                        }`}
                      />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-slate-800">تنبيهات النفاذ الحرج للمخزون</span>
                        <span
                          className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${
                            draftCritical ? 'bg-rose-100 text-rose-800 border border-rose-300/50' : 'bg-slate-200 text-slate-700'
                          }`}
                        >
                          {draftCritical ? 'مفعّلة' : 'متوقفة'}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-500">
                        إشعار فوري عند اقتراب نفاد الدواء أو نفاذه (حسب إعداد كل دواء)
                      </p>
                    </div>
                  </div>
                                    <Toggle
                    id="settings-toggle-critical"
                    checked={draftCritical}
                    onChange={onToggleCritical}
                    label={
                      draftCritical
                        ? 'تنبيهات المخزون الحرج مفعلة — انقر للإيقاف'
                        : 'تنبيهات المخزون الحرج متوقفة — انقر للتفعيل'
                    }
                    color="rose"
                  />
                </div>
                {/* Test Notification Button */}
                {onSendTestNotification && (
                  <button
                    type="button"
                    onClick={onSendTestNotification}
                    className="w-full h-10 px-4 bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300/80 rounded-full text-xs font-semibold flex items-center justify-center gap-2 transition active:scale-98 cursor-pointer"
                  >
                    <Bell className="w-4 h-4 text-amber-600" />
                    <span>تجربة إشعار وتنبيه صوتي الآن (اختبار فوري)</span>
                  </button>
                )}
                {/* Exact-alarm permission warning (Android 12+) */}
                {draftNotifications && exactAlarmPermission === 'denied' && onOpenExactAlarmSettings && (
                  <div className="bg-rose-50 border border-rose-300/80 rounded-2xl p-3.5 space-y-2">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                      <div className="text-[11px] text-rose-900 leading-relaxed">
                        <strong>تنبيه: المنبهات الدقيقة غير مفعّلة</strong>
                        <br />
                        لضمان وصول تذكير الجرعة في موعده بالضبط، اسمح للتطبيق باستخدام
                        المنبهات الدقيقة من إعدادات Android. بدون هذا الإذن قد يتأخر
                        التذكير دقائق أو ساعات.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={onOpenExactAlarmSettings}
                      className="w-full h-10 px-4 bg-rose-600 hover:bg-rose-700 text-white rounded-full text-xs font-semibold flex items-center justify-center gap-2 transition active:scale-98 shadow-2xs cursor-pointer"
                    >
                      <Bell className="w-4 h-4" />
                      <span>السماح بالمنبهات الدقيقة (إعدادات Android)</span>
                    </button>
                  </div>
                )}
                {/* Exact-alarm granted indicator */}
                {draftNotifications && exactAlarmPermission === 'granted' && (
                  <div className="flex items-center gap-1.5 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                    <span>المنبهات الدقيقة مفعّلة — تذكيرات الجرعات مضمونة في موعدها</span>
                  </div>
                )}

              </div>
);
