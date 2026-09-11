# 💊 النغنغ - متتبع الأدوية (Drug Tracker)

تطبيق ويب تقدمي (PWA) لمتابعة مخزون الأدوية وتنبيهك عند اقتراب نفاذ الحبوب بناءً على معدل الاستهلاك اليومي.

![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)
![React](https://img.shields.io/badge/React-19.2-61dafb.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

---

## ✨ المميزات الرئيسية

| الميزة | الوصف |
|--------|-------|
| 📦 **تتبع المخزون** | إدارة كمية الأدوية المتبقية مع حساب تلقائي للاستهلاك اليومي |
| ⏰ **تنبيهات ذكية** | إشعارات عند اقتراب نفاذ الدواء بناءً على معدل الاستخدام |
| 🔔 **منبهات الجرعات** | تذكير بمواعيد تناول الدواء مع أصوات مخصصة |
| 🛒 **قائمة التسوق** | إنشاء قائمة مشتريات تلقائية للأدوية المنخفضة المخزون |
| 🏪 **إدارة الصيدليات** | حفظ بيانات الصيدليات المفضلة ومشاركة الطلبات عبر واتساب |
| 📊 **سجل الاستهلاك** | تتبع تاريخ أخذ الجرعات مع إمكانية التراجع |
| 📱 **دعم PWA** | يعمل كتطبيق مستقل على الهاتف دون متجر التطبيقات |
| 🤖 **APK أندرويد** | إمكانية بناء تطبيق أندرويد أصلي باستخدام Capacitor |

---

## 🛠️ التقنيات المستخدمة

- **الواجهة الأمامية**: React 19 + TypeScript + Tailwind CSS 4
- **البناء**: Vite 6
- **التخزين المحلي**: LocalStorage / IndexedDB
- **الإشعارات**: Web Notifications API + Capacitor Local Notifications
- **PWA**: Service Worker + Manifest
- **أندرويد**: Capacitor 6
- **الاختبارات**: Vitest + Testing Library
- **الجودة**: ESLint + Prettier

---

## 🚀 البدء السريع

### المتطلبات

- Node.js 20 أو أحدث
- npm أو yarn

### التثبيت

```bash
# استنساخ المستودع
git clone https://github.com/youssef9449/DrugTracker.git
cd DrugTracker

# تثبيت الاعتماديات
npm install

# تشغيل خادم التطوير
npm run dev
```

سيفتح التطبيق على `http://localhost:3000`

---

## 📜 الأوامر المتوفرة

| الأمر | الوظيفة |
|-------|---------|
| `npm run dev` | تشغيل خادم التطوير |
| `npm run build` | بناء نسخة الإنتاج |
| `npm run preview` | معاينة نسخة الإنتاج |
| `npm run test` | تشغيل الاختبارات |
| `npm run test:coverage` | تشغيل الاختبارات مع تقرير التغطية |
| `npm run lint` | فحص الأخطاء البرمجية |
| `npm run typecheck` | فحص أنواع TypeScript |
| `npm run icons` | توليد الأيقونات |
| `npm run cap:sync` | مزامنة بناء الويب مع مشروع أندرويد |
| `npm run apk:debug` | بناء APK للتطوير |

---

## 📱 بناء APK أندرويد

لتثبيت التطبيق كتطبيق أندرويد أصلي، راجع دليل [BUILD_APK.md](./BUILD_APK.md) للتعليمات التفصيلية.

باختصار:

```bash
npm run build
npx cap sync android
npx cap open android
```

ثم في Android Studio: **Build → Build APK(s)**

---

## 📁 هيكل المشروع

```
DrugTracker/
├── public/              # الملفات الثابتة (الأيقونات، Service Worker)
├── screenshots/         # لقطات الشاشة
├── scripts/             # سكربتات المساعدة
├── src/
│   ├── components/      # مكونات React
│   │   └── ui/          # مكونات الواجهة الأساسية
│   ├── constants/       # الثوابت والنصوص
│   ├── data/            # البيانات الأولية
│   ├── hooks/           # React Hooks مخصصة
│   ├── lib/             # مكتبات مساعدة
│   ├── types/           # تعريفات TypeScript
│   └── utils/           # دوال مساعدة
├── BUILD_APK.md         # دليل بناء APK
├── capacitor.config.ts  # إعدادات Capacitor
├── index.html           # الصفحة الرئيسية
├── metadata.json        # بيانات التطبيق
├── package.json         # إعدادات المشروع
└── vite.config.ts       # إعدادات Vite
```

---

## 🤝 المساهمة

المساهمات مرحب بها! يرجى اتباع الخطوات التالية:

1. Fork المشروع
2. إنشاء فرع جديد (`git checkout -b feature/amazing-feature`)
3. Commit التغييرات (`git commit -m 'Add amazing feature'`)
4. Push إلى الفرع (`git push origin feature/amazing-feature`)
5. فتح Pull Request

---

## 📄 الترخيص

هذا المشروع مرخص تحت رخصة MIT - راجع ملف [LICENSE](./LICENSE) للتفاصيل.

---

## 📞 التواصل

- **المطور**: youssef9449
- **GitHub**: [youssef9449](https://github.com/youssef9449)

---

<div align="center">
  صُنع بـ ❤️ لمتابعة صحتك وصحة من تحب
</div>
