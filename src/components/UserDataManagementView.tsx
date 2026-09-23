import { useState, type FC, type FormEvent } from 'react';
import { Check, MapPin, Pencil, Phone, Plus, Trash2, X } from 'lucide-react';
import type { UserAddress, UserContact } from '../types';
import { generateId } from '../utils/id';
import { Modal } from './ui/Modal';

interface UserDataManagementViewProps {
  contacts: UserContact[];
  addresses: UserAddress[];
  onSaveContact: (contact: UserContact) => void;
  onDeleteContact: (id: string) => void;
  onSaveAddress: (address: UserAddress) => void;
  onDeleteAddress: (id: string) => void;
  showToast: (message: string) => void;
}

type EditingItem =
  | { kind: 'contact'; item: UserContact | null }
  | { kind: 'address'; item: UserAddress | null };

export const UserDataManagementView: FC<UserDataManagementViewProps> = ({
  contacts,
  addresses,
  onSaveContact,
  onDeleteContact,
  onSaveAddress,
  onDeleteAddress,
  showToast,
}) => {
  const [editing, setEditing] = useState<EditingItem | null>(null);
  const [form, setForm] = useState({ label: '', value: '' });

  const openContactForm = (contact?: UserContact) => {
    setEditing({ kind: 'contact', item: contact || null });
    setForm({ label: contact?.label || '', value: contact?.phone || '' });
  };

  const openAddressForm = (address?: UserAddress) => {
    setEditing({ kind: 'address', item: address || null });
    setForm({ label: address?.label || '', value: address?.address || '' });
  };

  const closeForm = () => setEditing(null);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const label = form.label.trim();
    if (!label || !editing) {
      showToast('اكتب اسمًا تعريفيًا للبيانات.');
      return;
    }

    if (editing.kind === 'contact') {
      const phone = form.value.trim();
      if (!phone) {
        showToast('اكتب رقم تليفون صحيحًا.');
        return;
      }
      onSaveContact({ id: editing.item?.id || generateId('contact'), label, phone });
      showToast(editing.item ? 'تم تعديل رقم التليفون.' : 'تمت إضافة رقم التليفون.');
    } else {
      const address = form.value.trim();
      if (!address) {
        showToast('اكتب العنوان بالتفصيل.');
        return;
      }
      onSaveAddress({ id: editing.item?.id || generateId('address'), label, address });
      showToast(editing.item ? 'تم تعديل العنوان.' : 'تمت إضافة العنوان.');
    }
    closeForm();
  };

  return (
    <div className="p-4 space-y-4" dir="rtl">
      <div>
        <h2 className="text-lg font-bold text-slate-900">بياناتي</h2>
        <p className="text-xs text-slate-500 mt-1">إدارة الأرقام والعناوين التي يمكن إضافتها إلى طلبات واتساب.</p>
      </div>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Phone className="w-5 h-5 text-teal-700" />
            <h3 className="font-bold text-slate-900">أرقام التليفون</h3>
          </div>
          <button
            type="button"
            onClick={() => openContactForm()}
            className="h-10 px-4 rounded-full bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold flex items-center gap-1.5 shadow-2xs transition cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>إضافة</span>
          </button>
        </div>
        {contacts.length === 0 ? (
          <div className="bg-white border border-dashed border-slate-300 rounded-3xl p-6 text-center text-sm text-slate-500">
            لم تتم إضافة أرقام بعد.
          </div>
        ) : (
          <div className="space-y-2">
            {contacts.map((contact) => (
              <div
                key={contact.id}
                className="bg-white rounded-2xl border border-slate-200 p-3.5 flex items-center justify-between gap-3 shadow-2xs"
              >
                <div className="min-w-0">
                  <h4 className="font-bold text-slate-900 truncate">{contact.label}</h4>
                  <p className="text-xs text-slate-500 mt-1 font-mono" dir="ltr">+{contact.phone}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => openContactForm(contact)}
                    aria-label={`تعديل ${contact.label}`}
                    className="w-9 h-9 rounded-full bg-slate-100 text-slate-700 hover:bg-slate-200 transition flex items-center justify-center cursor-pointer"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteContact(contact.id)}
                    aria-label={`حذف ${contact.label}`}
                    className="w-9 h-9 rounded-full bg-rose-50 text-rose-700 hover:bg-rose-100 transition flex items-center justify-center cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <MapPin className="w-5 h-5 text-teal-700" />
            <h3 className="font-bold text-slate-900">العناوين</h3>
          </div>
          <button
            type="button"
            onClick={() => openAddressForm()}
            className="h-10 px-4 rounded-full bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold flex items-center gap-1.5 shadow-2xs transition cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>إضافة</span>
          </button>
        </div>
        {addresses.length === 0 ? (
          <div className="bg-white border border-dashed border-slate-300 rounded-3xl p-6 text-center text-sm text-slate-500">
            لم تتم إضافة عناوين بعد.
          </div>
        ) : (
          <div className="space-y-2">
            {addresses.map((address) => (
              <div
                key={address.id}
                className="bg-white rounded-2xl border border-slate-200 p-3.5 flex items-center justify-between gap-3 shadow-2xs"
              >
                <div className="min-w-0">
                  <h4 className="font-bold text-slate-900 truncate">{address.label}</h4>
                  <p className="text-xs text-slate-500 mt-1 truncate">{address.address}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => openAddressForm(address)}
                    aria-label={`تعديل ${address.label}`}
                    className="w-9 h-9 rounded-full bg-slate-100 text-slate-700 hover:bg-slate-200 transition flex items-center justify-center cursor-pointer"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteAddress(address.id)}
                    aria-label={`حذف ${address.label}`}
                    className="w-9 h-9 rounded-full bg-rose-50 text-rose-700 hover:bg-rose-100 transition flex items-center justify-center cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {editing && (
        <Modal isOpen={Boolean(editing)} onClose={closeForm} label={editing.item ? 'تعديل البيانات' : 'إضافة بيانات'}>
          <form onSubmit={handleSubmit} className="bg-white rounded-[28px] shadow-xl border border-slate-200/80 w-full max-w-md p-5 space-y-4" dir="rtl">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-slate-900 text-base">{editing.item ? 'تعديل البيانات' : 'إضافة بيانات'}</h3>
              <button
                type="button"
                onClick={closeForm}
                aria-label="إغلاق"
                className="w-10 h-10 rounded-full hover:bg-slate-100 text-slate-500 flex items-center justify-center transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <label className="block text-xs font-bold text-slate-700">
              الاسم التعريفي
              <input
                required
                value={form.label}
                onChange={(event) => setForm({ ...form, label: event.target.value })}
                placeholder={editing.kind === 'contact' ? 'مثال: رقمي الشخصي' : 'مثال: عنوان البيت'}
                className="mt-1 w-full px-3 py-2.5 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-teal-700"
              />
            </label>
            <label className="block text-xs font-bold text-slate-700">
              {editing.kind === 'contact' ? 'رقم التليفون' : 'العنوان بالتفصيل'}
              <input
                required
                type={editing.kind === 'contact' ? 'tel' : 'text'}
                value={form.value}
                onChange={(event) => setForm({ ...form, value: event.target.value })}
                className="mt-1 w-full px-3 py-2.5 rounded-xl border border-slate-300 font-mono focus:outline-none focus:ring-2 focus:ring-teal-700"
                dir={editing.kind === 'contact' ? 'ltr' : 'rtl'}
              />
            </label>
            <button
              type="submit"
              className="w-full h-11 rounded-full bg-teal-700 hover:bg-teal-800 active:bg-teal-900 text-white font-semibold text-sm flex items-center justify-center gap-2 shadow-xs transition cursor-pointer"
            >
              <Check className="w-4 h-4" /> حفظ
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
};
