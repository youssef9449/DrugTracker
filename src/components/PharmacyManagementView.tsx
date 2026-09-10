import { useState, type FC, type FormEvent } from 'react';
import { Check, Pencil, Plus, Store, Trash2, X } from 'lucide-react';
import type { Pharmacy } from '../types';
import { cleanPhoneNumber } from '../utils/whatsapp';
import { Modal } from './ui/Modal';

interface PharmacyManagementViewProps {
  pharmacies: Pharmacy[];
  onSave: (pharmacy: Pharmacy) => void;
  onDelete: (id: string) => void;
  showToast: (message: string) => void;
}

export const PharmacyManagementView: FC<PharmacyManagementViewProps> = ({ pharmacies, onSave, onDelete, showToast }) => {
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editing, setEditing] = useState<Pharmacy | null>(null);
  const [form, setForm] = useState({ name: '', phone: '', customerCode: '' });

  const openForm = (pharmacy?: Pharmacy) => {
    setEditing(pharmacy || null);
    setForm(pharmacy ? { name: pharmacy.name, phone: pharmacy.phone, customerCode: pharmacy.customerCode } : { name: '', phone: '', customerCode: '' });
    setIsFormOpen(true);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const name = form.name.trim();
    const phone = cleanPhoneNumber(form.phone);
    if (!name || !phone) {
      showToast('اكتب اسم الصيدلية ورقم واتساب صحيحًا.');
      return;
    }
    onSave({ id: editing?.id || `pharmacy-${Date.now()}`, name, phone, customerCode: form.customerCode.trim() });
    setIsFormOpen(false);
    showToast(editing ? 'تم تحديث بيانات الصيدلية.' : 'تمت إضافة الصيدلية.');
  };

  return (
    <div className="p-4 space-y-4" dir="rtl">
      <div className="flex items-center justify-between gap-3">
        <div><h2 className="text-lg font-bold text-slate-900">إدارة الصيدليات</h2><p className="text-xs text-slate-500 mt-1">احفظ بيانات كل صيدلية لاستخدامها في الطلبات.</p></div>
        <button type="button" onClick={() => openForm()} className="px-3 py-2 rounded-xl bg-teal-700 text-white text-xs font-bold flex items-center gap-1.5"><Plus className="w-4 h-4" /> إضافة</button>
      </div>
      {pharmacies.length === 0 ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-2xl p-8 text-center text-sm text-slate-500"><Store className="w-8 h-8 mx-auto mb-2 text-slate-300" />لم تتم إضافة صيدليات بعد.</div>
      ) : (
        <div className="space-y-3">{pharmacies.map((pharmacy) => (
          <div key={pharmacy.id} className="bg-white rounded-2xl border border-slate-200 p-4 flex items-center justify-between gap-3">
            <div className="min-w-0"><h3 className="font-bold text-slate-900 truncate">{pharmacy.name}</h3><p className="text-xs text-slate-500 mt-1" dir="ltr">+{pharmacy.phone}</p><p className="text-xs text-slate-500 mt-1">كود العميل: {pharmacy.customerCode || 'غير محدد'}</p></div>
            <div className="flex items-center gap-1 shrink-0"><button type="button" onClick={() => openForm(pharmacy)} aria-label={`تعديل ${pharmacy.name}`} className="p-2 rounded-xl bg-slate-100 text-slate-700"><Pencil className="w-4 h-4" /></button><button type="button" onClick={() => onDelete(pharmacy.id)} aria-label={`حذف ${pharmacy.name}`} className="p-2 rounded-xl bg-rose-50 text-rose-700"><Trash2 className="w-4 h-4" /></button></div>
          </div>
        ))}</div>
      )}
      {isFormOpen && (
        <Modal
          isOpen={isFormOpen}
          onClose={() => setIsFormOpen(false)}
          label={editing ? 'تعديل الصيدلية' : 'إضافة صيدلية'}
        >
          <form onSubmit={handleSubmit} className="bg-white rounded-3xl w-full max-w-md p-5 space-y-4" dir="rtl">
            <div className="flex items-center justify-between"><h3 className="font-bold text-slate-900">{editing ? 'تعديل الصيدلية' : 'إضافة صيدلية'}</h3><button type="button" onClick={() => setIsFormOpen(false)} aria-label="إغلاق"><X className="w-5 h-5 text-slate-500" /></button></div>
            <label className="block text-xs font-bold text-slate-700">اسم الصيدلية<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="mt-1 w-full px-3 py-2.5 rounded-xl border border-slate-300" /></label>
            <label className="block text-xs font-bold text-slate-700">رقم واتساب الصيدلية<input required type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="mt-1 w-full px-3 py-2.5 rounded-xl border border-slate-300 font-mono" dir="ltr" /></label>
            <label className="block text-xs font-bold text-slate-700">كود العميل<input value={form.customerCode} onChange={(e) => setForm({ ...form, customerCode: e.target.value })} className="mt-1 w-full px-3 py-2.5 rounded-xl border border-slate-300 font-mono" dir="ltr" /></label>
            <button type="submit" className="w-full py-3 rounded-xl bg-teal-700 text-white font-bold flex items-center justify-center gap-2"><Check className="w-4 h-4" /> حفظ</button>
          </form>
        </Modal>
      )}
    </div>
  );
};