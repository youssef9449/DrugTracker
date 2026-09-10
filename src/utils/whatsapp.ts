import { Medication, describeOrderInBoxes } from '../types';

export function normalizeArabicDigits(input: string): string {
  if (!input) return '';
  const arabicEasternDigits = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
  const persianDigits = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
  let res = input;
  for (let i = 0; i < 10; i++) {
    res = res.replace(new RegExp(arabicEasternDigits[i], 'g'), i.toString());
    res = res.replace(new RegExp(persianDigits[i], 'g'), i.toString());
  }
  return res;
}

/**
 * Clean a user-entered phone number into the international E.164-ish
 * format `wa.me` expects (country code + number, no `+`, no spaces).
 *
 * The app is targeted at Egyptian users, so Egyptian local numbers are
 * auto-prefixed with the country code `20`:
 *   - 01xxxxxxxxx  (11-digit Egyptian mobile)  → 201xxxxxxxxx
 *   - 0[2-9]xxxxxxx (Egyptian landline)       → 202xxxxxxx…
 *
 * Numbers already in international format (with a leading `+` or `00`
 * or a 1–3 digit country code other than `20`) are preserved as-is, so
 * non-Egyptian users who enter their full international number (e.g.
 * `+9665xxxxxxxx`, `009715xxxxxxxx`) are NOT mangled into an Egyptian
 * number. The caller should encourage international users to include
 * the country code.
 *
 * Returns '' for empty input. Non-digits are stripped (spaces, dashes,
 * parentheses, leading `+`).
 */
export function cleanPhoneNumber(rawPhone: string): string {
  if (!rawPhone) return '';
  // #28: normalize Arabic/Persian digits to 0-9, then strip ALL
  // non-digit characters (not just spaces/dashes/parens/plus — letters,
  // dots, slashes, colons etc. also leak through and produce invalid
  // wa.me URLs). The 00 international prefix is handled below.
  let cleaned = normalizeArabicDigits(rawPhone).replace(/\D/g, '');

  // Strip leading 00 (international prefix) → the rest is already the
  // country code + number, keep it verbatim.
  if (cleaned.startsWith('00')) {
    cleaned = cleaned.substring(2);
  }

  // Egyptian mobile with extra 0 after 20 (e.g. +20010..., 20010...) → 201xxxxxxxxx
  if (/^2001[0125][0-9]{8}$/.test(cleaned)) {
    return '20' + cleaned.substring(3);
  }

  // Egyptian mobile format: 01xxxxxxxxx (11 digits starting with 010/011/012/015)
  // → 201xxxxxxxxx
  if (/^01[0125][0-9]{8}$/.test(cleaned)) {
    return '20' + cleaned.substring(1);
  }

  // Egyptian mobile without leading 0: 1[0125]xxxxxxxx (10 digits)
  // → 201xxxxxxxxx
  if (/^1[0125][0-9]{8}$/.test(cleaned)) {
    return '20' + cleaned;
  }

  // Egyptian landlines with extra 0 after 20: 2002xxxxxxx → 202xxxxxxx
  if (/^200[2-9][0-9]{7,8}$/.test(cleaned)) {
    return '20' + cleaned.substring(3);
  }

  // Egyptian landlines / area codes (e.g. 02xxxxxxx, 03xxxxxxx) → 202xxxxxxx
  if (/^0[2-9][0-9]{7,8}$/.test(cleaned)) {
    return '20' + cleaned.substring(1);
  }

  // Anything else (already-international numbers without a leading 00,
  // or a leading country code) is returned as-is. wa.me accepts a bare
  // country-code + number.
  return cleaned;
}

export interface OrderItem {
  name: string;
  quantity: number;
  unit: string;
  currentStock?: number;
  stripsPerBox?: number;
  pillsPerStrip?: number;
  packageSize?: number;
}

export function generatePharmacyOrderMessage(
  items: OrderItem[],
  customerCode: string = '',
  address?: string,
  contactPhone?: string
): string {
  if (items.length === 0) return '';

  let text = `السلام عليكم ورحمة الله،\nمن فضلك عايز الأدوية دي:\n\n`;

  items.forEach((item, idx) => {
    const packagingDesc = describeOrderInBoxes(
      item.quantity,
      item.stripsPerBox,
      item.pillsPerStrip,
      item.packageSize,
      item.unit
    );

    // If packaging description is more specific than just "X قرص", include it
    if (packagingDesc && packagingDesc !== `${item.quantity} ${item.unit}`) {
      text += `${idx + 1}. ${item.name} - المطلوب: ${packagingDesc}\n`;
    } else {
      text += `${idx + 1}. ${item.name} - الكمية: ${item.quantity} ${item.unit}\n`;
    }
  });

  // Only include "رقم العميل" if the user actually entered a code.
  // The user explicitly asked for this: "خلي الجزء بتاع رقم العميل
  // اختياري يعني لو مش مكتوب في الصندوق حاجة ميكتبهوش في الرسالة".
  const code = (customerCode || '').trim();
  if (code) {
    text += `\nرقم العميل ${code}`;
  }

  // Append address if provided (same logic — optional, only show
  // if non-empty).
  if (address && address.trim()) {
    text += `\nالعنوان: ${address.trim()}`;
  }

  // Append contact phone if provided
  if (contactPhone && contactPhone.trim()) {
    text += `\nرقم التواصل: ${contactPhone.trim()}`;
  }

  return text;
}

export function buildWhatsAppUrl(phone: string, message: string): string {
  const clean = cleanPhoneNumber(phone);
  const encodedText = encodeURIComponent(message);

  if (clean) {
    // wa.me format is the most universal WhatsApp deep-link across Android, iOS and Web
    return `https://wa.me/${clean}?text=${encodedText}`;
  }
  return `https://wa.me/?text=${encodedText}`;
}

export function buildWhatsAppApiUrl(phone: string, message: string): string {
  const clean = cleanPhoneNumber(phone);
  const encodedText = encodeURIComponent(message);

  if (clean) {
    return `https://api.whatsapp.com/send?phone=${clean}&text=${encodedText}`;
  }
  return `https://api.whatsapp.com/send?text=${encodedText}`;
}

export function buildWhatsAppAppUrl(phone: string, message: string): string {
  const clean = cleanPhoneNumber(phone);
  const encodedText = encodeURIComponent(message);

  if (clean) {
    return `whatsapp://send?phone=${clean}&text=${encodedText}`;
  }
  return `whatsapp://send?text=${encodedText}`;
}

export function buildWhatsAppWebUrl(phone: string, message: string): string {
  const clean = cleanPhoneNumber(phone);
  const encodedText = encodeURIComponent(message);

  if (clean) {
    return `https://web.whatsapp.com/send?phone=${clean}&text=${encodedText}`;
  }
  return `https://web.whatsapp.com/send?text=${encodedText}`;
}

/**
 * Open a WhatsApp deep-link in a new tab or the WhatsApp app.
 *
 * Robust multi-tier strategy:
 * 1. Direct window.open (works when called synchronously in click handlers)
 * 2. Fallback to synthetic anchor appended to document.body and clicked
 * Returns boolean indicating whether a navigation attempt was made.
 */
export function openWhatsAppLink(phone: string, message: string): boolean {
  const url = buildWhatsAppUrl(phone, message);
  let opened = false;

  // Tier 1: Try window.open first (standard browser API for user-initiated gestures)
  try {
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if (win) {
      opened = true;
    }
  } catch {
    // window.open blocked by sandbox or browser popup settings
  }

  // Tier 2: Synthetic anchor click (Firefox & Safari user-gesture fallback)
  try {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    opened = true;
  } catch {
    // anchor click blocked
  }

  return opened;
}

export interface CalculatedOrderQuantity {
  quantity: number;
  isCustom: boolean;
  baseMonthlyQuantity: number;
  monthsMultiplier: number;
}

/**
 * Calculates medication order quantity according to coverage duration
 * (1 month / 30 days vs 2 months / 60 days).
 *
 * Key insight: the returned `quantity` is the exact number of PILLS
 * needed (not rounded up to whole boxes). The caller then passes
 * this quantity to `describeOrderInBoxes()` which breaks it down
 * into "X boxes + Y strips + Z loose pills" — so the pharmacy order
 * reads naturally: "علبة واحدة و شريط (30 قرص)" instead of
 * "علبتان (40 قرص)" when the user only needs 30.
 *
 * - If the user set a custom quantity: use that (×2 for 60 days).
 * - If dailyDose > 0 and monthly consumption exceeds one package:
 *   order the exact pill count (e.g., 30 pills for 1/day × 30 days).
 * - If dailyDose > 0 but monthly consumption fits in one package:
 *   order one full package (the user doesn't need a partial strip).
 * - If dailyDose is 0 or unset: order one package.
 */
export function calculateMedicationOrderQuantity(
  med: Medication,
  durationDays: 30 | 60,
  customQuantities?: Record<string, number>
): CalculatedOrderQuantity {
  const monthsMultiplier = durationDays === 60 ? 2 : 1;
  const packSize =
    med.stripsPerBox && med.pillsPerStrip && med.stripsPerBox > 0 && med.pillsPerStrip > 0
      ? med.stripsPerBox * med.pillsPerStrip
      : med.packageSize && med.packageSize > 0
      ? med.packageSize
      : 30;

  // 1. If user explicitly specified a custom base monthly quantity
  if (
    customQuantities &&
    customQuantities[med.id] !== undefined &&
    customQuantities[med.id] > 0
  ) {
    const baseMonthlyQuantity = customQuantities[med.id];
    return {
      quantity: baseMonthlyQuantity * monthsMultiplier,
      isCustom: true,
      baseMonthlyQuantity,
      monthsMultiplier,
    };
  }

  // 2. Automatic baseline calculation for 1 month (30 days):
  let baseMonthlyQuantity: number;
  if (med.dailyDose > 0) {
    const monthlyConsumption = Math.ceil(med.dailyDose * 30);
    if (monthlyConsumption > packSize) {
      // Need more than 1 package — order the EXACT number of pills.
      // describeOrderInBoxes will break it down into
      // "X boxes + Y strips + Z loose pills" so the pharmacy can
      // fulfil the order precisely (e.g., 30 pills = 1 box + 1 strip
      // when the box holds 20).
      baseMonthlyQuantity = monthlyConsumption;
    } else {
      // Need less than 1 package — just order 1 full package.
      baseMonthlyQuantity = packSize;
    }
  } else {
    // No daily dose specified — order 1 package.
    baseMonthlyQuantity = packSize;
  }

  return {
    quantity: baseMonthlyQuantity * monthsMultiplier,
    isCustom: false,
    baseMonthlyQuantity,
    monthsMultiplier,
  };
}


