# 💊 متتبع الأدوية (Drug Tracker)

تطبيق أندرويد لإدارة الأدوية ومتابعة المخزون، مواعيد الجرعات، الاستهلاك اليومي، التنبيهات، وقائمة شراء الأدوية.

يعتمد التطبيق على واجهة React/TypeScript، مع Capacitor لدمج التطبيق مع Android، ويحتوي على مسار أصلي للمنبهات والتنفيذ الدقيق لخصم الجرعات التلقائي حتى عندما لا تكون واجهة التطبيق قيد التشغيل.

![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)
![React](https://img.shields.io/badge/React-19.2-61dafb.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6.svg)
![Capacitor](https://img.shields.io/badge/Capacitor-6-119EFF.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

---

## ✨ المميزات الرئيسية

| الميزة | الوصف |
|--------|-------|
| 📦 **إدارة المخزون** | متابعة الكمية الحالية للأدوية وحساب الرصيد الفعلي المعروض للمستخدم |
| 💊 **تسجيل الجرعات** | دعم جرعة واحدة أو عدة جرعات يوميًا، مع تعريف مستقل لكل موعد جرعة |
| ⏰ **خصم تلقائي دقيق للجرعات** | جدولة كل جرعة تلقائيًا على وقتها المحدد بدل الاعتماد على فتح التطبيق أو تسوية يومية فقط |
| 🔔 **منبهات وتنبيهات الجرعات** | تذكير بمواعيد الجرعات ودعم مسار التنبيه داخل التطبيق وعلى Android |
| 💤 **تأجيل الجرعة** | التعامل مع تأجيل التنبيهات والعودة إلى دورة الجرعة الطبيعية |
| 🛒 **قائمة الشراء** | إنشاء كميات الشراء المطلوبة للأدوية ذات المخزون المنخفض مع دعم التعبئة والوحدات المختلفة |
| 🏪 **إدارة الصيدليات** | حفظ بيانات الصيدليات ومشاركة طلبات الشراء عبر واتساب |
| 📊 **سجل الاستهلاك** | حفظ تاريخ الجرعات والاستهلاك ومعلومات التغيير المرتبطة بها |
| 📱 **PWA** | إمكانية تشغيل التطبيق كتطبيق ويب مستقل على الأجهزة الداعمة |
| 🤖 **Android / APK** | تغليف نسخة الويب كتطبيق Android أصلي باستخدام Capacitor |

---

## ⏱️ الخصم التلقائي الدقيق للجرعات

يستخدم التطبيق بنية هجينة تفصل بين **توقيت الجرعة** و**تعديل المخزون**:

```text
جدولة الجرعة من JavaScript
        ↓
Android AlarmManager
        ↓
تسجيل FIRED بشكل دائم في التخزين الأصلي
        ↓
عند تشغيل التطبيق / استئنافه بعد hydration
        ↓
JavaScript reconciliation
        ↓
تعديل المخزون والسجل مرة واحدة فقط
        ↓
تسجيل RECONCILED
```

### مبادئ أساسية

- Android مسؤول عن الوصول إلى **وقت الجرعة الفعلي** وتسجيل حدث إطلاقها بشكل دائم.
- JavaScript مسؤول عن **المخزون والسجل وعلامات الاستهلاك**.
- هوية كل occurrence تعتمد على:

```text
medicationId + doseId + calendarDate
```

وليس على ترتيب الجرعات أو الفهرس أو قيمة `dailyDose` وحدها.

- الجرعات المتعددة في اليوم مستقلة عن بعضها؛ تطبيق جرعة لا يؤدي إلى خصم جرعة شقيقة تلقائيًا.
- توجد آليات idempotency وdurability تمنع الخصم المكرر عند إعادة المحاولة أو فشل تأكيد الحدث الأصلي.
- `currentPills` هو رصيد المخزون المحفوظ (durable). لا يوجد إسقاط elapsed-days عند القراءة؛ خصم الجرعات التلقائي يأتي فقط من Exact FIRED occurrences.

التفاصيل التقنية الكاملة موجودة في [`docs/AUTO_DEDUCTION_ARCHITECTURE.md`](./docs/AUTO_DEDUCTION_ARCHITECTURE.md).

> **ملاحظة:** وجود اختبارات تغطي المنطق لا يعني أن مسار Android الكامل تم إثباته على جهاز فعلي. التحقق الميداني من سلسلة AlarmManager → FIRED → cold start → stock apply → RECONCILED يجب تسجيله بشكل مستقل عند تنفيذه.

---

## 🛠️ التقنيات المستخدمة

- **Frontend:** React 19 + TypeScript
- **Styling:** Tailwind CSS 4
- **Build:** Vite 6
- **Local persistence:** LocalStorage / IndexedDB بحسب مسار البيانات
- **Notifications:** Web Notifications API + Capacitor Local Notifications
- **PWA:** Service Worker + Web App Manifest
- **Android:** Capacitor 6 + native Java components
- **Scheduling:** Android AlarmManager لمسار الخصم التلقائي الدقيق
- **Testing:** Vitest + Testing Library
- **Code quality:** ESLint + Prettier

---

## 🚀 البدء السريع

### المتطلبات

- Node.js 20 أو أحدث
- npm أو yarn
- لتطوير Android: Android Studio وAndroid SDK المناسبان

### تشغيل نسخة الويب

```bash
git clone https://github.com/youssef9449/DrugTracker.git
cd DrugTracker
npm install
npm run dev
```

سيتوفر خادم التطوير على:

`http://localhost:3000`

---

## 📜 أوامر المشروع

| الأمر | الوظيفة |
|-------|---------|
| `npm run dev` | تشغيل خادم التطوير |
| `npm run build` | بناء نسخة الإنتاج |
| `npm run preview` | معاينة نسخة الإنتاج |
| `npm run test` | تشغيل الاختبارات |
| `npm run test:coverage` | تشغيل الاختبارات مع تقرير التغطية |
| `npm run lint` | فحص قواعد ESLint |
| `npm run typecheck` | فحص TypeScript بدون إصدار ملفات |
| `npm run icons` | توليد الأيقونات |
| `npm run cap:sync` | بناء الويب ومزامنته مع مشروع Android |
| `npm run cap:add` | إضافة مشروع Android لأول مرة |
| `npm run cap:studio` | مزامنة المشروع وفتحه في Android Studio |
| `npm run apk:debug` | إنشاء Debug APK عبر Gradle |

---

## 📱 Android وAPK

التطبيق هو React SPA يتم تغليف نسخة الإنتاج الخاصة به داخل Android WebView بواسطة Capacitor.

معرّف التطبيق Android هو:

`app.drugtracker`

لخطوات بناء APK التفصيلية راجع [`BUILD_APK.md`](./BUILD_APK.md).

للتفاصيل الخاصة ببنية الخصم التلقائي الدقيق ومسار Android الأصلي راجع [`docs/AUTO_DEDUCTION_ARCHITECTURE.md`](./docs/AUTO_DEDUCTION_ARCHITECTURE.md).

---

## 📁 هيكل المشروع

```text
DrugTracker/
├── public/                  # الملفات الثابتة وموارد PWA
├── scripts/                 # سكربتات المساعدة والبناء
├── src/
│   ├── components/          # مكونات React وواجهات المستخدم
│   │   └── ui/              # مكونات الواجهة المشتركة
│   ├── constants/           # الثوابت والنصوص
│   ├── data/                # البيانات الأولية
│   ├── hooks/               # React Hooks المخصصة
│   ├── lib/                 # مكتبات داخلية مساعدة
│   ├── types/               # تعريفات TypeScript
│   └── utils/               # منطق الأعمال والدوال المساعدة
├── native-android/          # مكونات Android الأصلية لمسارات النظام الخاصة
├── Tests/                   # اختبارات React والمنطق والتكامل
├── docs/                    # التوثيق الفني
├── android/                 # مشروع Capacitor Android
├── capacitor.config.ts     # إعدادات Capacitor
├── index.html               # نقطة دخول الواجهة
├── metadata.json            # بيانات التطبيق
├── package.json             # إعدادات المشروع وأوامر التطوير
└── vite.config.ts           # إعدادات Vite
```

---

## 🧪 الاختبارات

يحتوي المشروع على اختبارات للواجهة والمنطق وعمليات التكامل، بما في ذلك:

- مكونات React الأساسية.
- دورة حياة الجرعات Take / Restore.
- حسابات واستهلاك المخزون.
- جدولة وإلغاء الجرعات.
- الخصم التلقائي الدقيق وإعادة المصالحة.
- التنبيهات والمنبهات.
- حالات الجرعات المتعددة وهوية `doseId`.

اختبارات Android الأصلية الموجودة في المشروع تختبر منطق المكونات الأصلية في بيئة JVM/Robolectric عندما يكون ذلك مناسبًا، بينما يظل التحقق الكامل على جهاز أو Emulator مسارًا منفصلًا.

---

## 🤝 المساهمة

المساهمات مرحب بها.

عند العمل على تغيير جديد:

1. أنشئ فرعًا مستقلًا من `main`.
2. اجعل التغيير محدود النطاق وواضح الهدف.
3. أضف أو حدّث الاختبارات ذات الصلة عند الحاجة.
4. افتح Pull Request يستهدف `main`.

قبل الدمج، يجب التأكد من أن التغيير لا يكسر عقود دورة حياة الجرعات، هوية occurrences، أو idempotency الخاصة بالخصم التلقائي.

---

## 📄 الترخيص

هذا المشروع مرخص تحت رخصة MIT — راجع [LICENSE](./LICENSE) للتفاصيل.

---

## 📞 التواصل

- **المطور:** youssef9449
- **GitHub:** [youssef9449](https://github.com/youssef9449)

---

<div align="center">
  صُنع بـ ❤️ لمتابعة الأدوية والمخزون والجرعات اليومية
</div>
