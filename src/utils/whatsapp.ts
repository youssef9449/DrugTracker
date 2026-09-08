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

export function cleanPhoneNumber(rawPhone: string): string {
  if (!rawPhone) return '';
  // Normalize Arabic numerals to standard 0-9 digits and strip spaces, dashes, parens, plus
  let cleaned = normalizeArabicDigits(rawPhone).replace(/[\s\-()+]/g, '');

  // If starts with 00, strip 00
  if (cleaned.startsWith('00')) {
    cleaned = cleaned.substring(2);
  }

  // Egyptian mobile format: 01xxxxxxxxx (11 digits starting with 010, 011, 012, 015) -> 201xxxxxxxxx
  if (/^01[0125][0-9]{8}$/.test(cleaned)) {
    cleaned = '20' + cleaned.substring(1);
  } else if (/^0[2-9][0-9]{7,8}$/.test(cleaned)) {
    // Egyptian landlines or area codes (e.g. 02xxxxxxx, 03xxxxxxx) -> 202xxxxxxx
    cleaned = '20' + cleaned.substring(1);
  }

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
  customerCode: string = '14739',
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

  const code = (customerCode || '14739').trim();
  text += `\nرقم العميل ${code}`;

  // Append address if provided
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

export function openWhatsAppLink(phone: string, message: string): void {
  const url = buildWhatsAppUrl(phone, message);
  const win = window.open(url, '_blank', 'noopener,noreferrer');
  if (!win || win.closed || typeof win.closed === 'undefined') {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
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


