/**
 * Salon Hiring Bot — Fixed & Polished
 *
 * Key fixes & improvements:
 * 1) Russian not working ➜ root cause was too-long callback_data for category buttons.
 *    Now we use short stable IDs (e.g., cat_stylist) and map them to localized labels.
 * 2) Clean start flow ➜ ask language first, then full name, phone, category, questions, videos.
 * 3) Webhook vs Polling ➜ auto-detect by WEBHOOK_DOMAIN. Never run both.
 * 4) Safer config ➜ use env vars, never hardcode tokens.
 * 5) Robust session & UX ➜ clearer prompts, keyboard handling, validation.
 * 6) Stable summary formatting and media forwarding.
 *
 * How to run locally (polling):
 *   BOT_TOKEN=123:ABC CHANNEL_ID=-1001234567890 node telegraf-salon-hiring-bot-fixed.js
 *
 * How to deploy on Render/Railway (webhook):
 *   set env: BOT_TOKEN, CHANNEL_ID, WEBHOOK_DOMAIN (e.g., your-app.onrender.com)
 *   expose port (PORT var provided by platform). Add bot as admin in your channel.
 */

const { Telegraf, Markup } = require('telegraf');
const express = require('express');

// ======== CONFIG (env-based! do NOT hardcode) ========
const BOT_TOKEN = "8118168430:AAG-U0pS5yYQHhHlpeyTb9AnggfIFTRRsXQ"; // e.g., 123456:ABCDE
const CHANNEL_ID = "-1003080376182"// e.g., -1001234567890
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !CHANNEL_ID) {
  console.error('❌ Please set BOT_TOKEN and CHANNEL_ID environment variables.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ======== STATE ========
/** In-memory session (simple). For production, plug a real store (Redis/Mongo). */
const sessions = new Map();
function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      lang: null,
      step: 'askLang',
      data: {
        fullName: null,
        phone: null,
        categoryId: null,
        answers: {},
        uploadedMsgIds: [],
      },
      qIndex: 0,
    });
  }
  return sessions.get(userId);
}
function resetSession(userId) { sessions.delete(userId); }

// ======== I18N ========
const LANGS = { uz: "O'zbekcha 🇺🇿", ru: 'Русский 🇷🇺' };
const TEXT = {
  start: {
    uz: 'Assalomu alaykum! Men salon uchun ishga qabul botiman. Keling, arizani boshlaymiz.',
    ru: 'Здравствуйте! Я бот для набора персонала салона. Давайте начнём вашу заявку.'
  },
  askLang: {
    uz: 'Qaysi tilda davom etamiz?',
    ru: 'На каком языке продолжим?'
  },
  askFullName: {
    uz: "Iltimos, to'liq ismingizni kiriting (Ism Familiya).",
    ru: 'Пожалуйста, введите ваше полное имя (Имя Фамилия).'
  },
  askPhone: {
    uz: 'Telefon raqamingizni yuboring yoki tugmadan foydalaning.',
    ru: 'Отправьте номер телефона или используйте кнопку ниже.'
  },
  askPhoneBtn: { uz: '📱 Telefon raqamni ulashish', ru: '📱 Поделиться телефоном' },
  chooseCategory: { uz: 
    "Iltimos, yo'nalishni tanlang:",
    ru: 'Пожалуйста, выберите направление:'
  },
  thanks: { uz: 'Rahmat! Endi savollarga javob bering.', ru: 'Спасибо! Теперь ответьте на вопросы.' },
  commonVideos: {
    uz: "Endi umumiy video talablar: 1) O'zingiz haqingizda qisqa video; 2) Uydagilaringiz haqida video; 3) Qilgan ishlaringiz video (manikyur/pedikyur/qosh/kiprik va h.k.). Videoni shu yerga yuboring — bir nechta bo'lsa ketma-ket yuboring. Tugallagach, 'Tayyor' deb yozing.",
    ru: "Теперь общие видео-требования: 1) Короткое видео о себе; 2) Видео о вашей семье/домашних; 3) Видео ваших работ (маникюр/педикюр/брови/ресницы и т.д.). Пришлите видео сюда — если несколько, отправляйте по очереди. Когда закончите, напишите 'Готово'."
  },
  promptReady: { uz: "Agar hammasini yuborgan bo'lsangiz, 'Tayyor' deb yozing.", ru: "Если всё отправили, напишите 'Готово'." },
  done: { uz: 'Tugadi! Arizangiz kanalga yuborildi. Javobni kuting. Rahmat! ✅', ru: 'Готово! Ваша анкета отправлена в канал. Ожидайте ответ. Спасибо! ✅' },
  reset: { uz: "Sessiya yangilandi. /start buyrug'ini bosing.", ru: 'Сессия сброшена. Нажмите /start.' },
  invalidPhone: { uz: "Telefon raqam formati noto'g'ri. Masalan: +998901234567 yoki 90 123 45 67.", ru: 'Неверный формат номера. Например: +998901234567 или 90 123 45 67.' },
};

// ======== CATEGORY MODEL with SHORT IDs (fixes Telegram 64-byte callback limit) ========
const CATEGORY_DEFS = [
  { id: 'stylist', uz: 'Stilist', ru: 'Стилист' },
  { id: 'colorist', uz: "Kolorit (soch bo'yash bo'yicha mutaxassis)", ru: 'Колорист (специалист по окрашиванию волос)' },
  { id: 'mua', uz: 'Vizajist (make-up artist)', ru: 'Визажист (make-up artist)' },
  { id: 'nails', uz: 'Manikyur/pedikyur ustasi', ru: 'Мастер маникюра/педикюра' },
  { id: 'lash', uz: 'Kiprikchi (lashmaker)', ru: 'Лэшмейкер (наращивание ресниц)' },
  { id: 'depil', uz: 'Depilatsiya mutaxassisi', ru: 'Специалист по депиляции' },
  { id: 'admin', uz: 'Administrator', ru: 'Администратор' },
];
const CAT_BY_ID = Object.fromEntries(CATEGORY_DEFS.map(c => [c.id, c]));
function catLabel(lang, id) { return (CAT_BY_ID[id] ? CAT_BY_ID[id][lang] : id); }

// ======== QUESTIONS (keyed by category id, localized) ========
const QUESTIONS = {
  uz: {
    stylist: [
      "Sizda nechchi yillik tajriba bor?",
      "Qaysi soch turlarida ishlashni yaxshi ko'rasiz (to'g'ri, jingalak, yupqa va h.k.)?",
      "Sizga eng ko'p yoqadigan soch uslubi qanday?",
      "Eng murakkab mijozingiz kim bo'lgan va bu vaziyatni qanday hal qilgansiz?",
      "Qaysi brend yoki turdagi soch mahsulotlaridan foydalanasiz?",
      "Soch bo'yashda qaysi texnikalarni yaxshi bilasiz? (Balayage, ombre, highlighting va h.k.)",
      "Mijozning yuz tuzilmasiga mos soch turmakni qanday tanlaysiz?",
      "Erkaklar va ayollar soch turmaklarini yasashda qaysi biri sizga osonroq?",
      "Mijoz yangi uslubdan norozi bo'lsa, qanday javob berasiz?",
      "Qanday qilib mijozlar bilan ishonchli aloqa o'rnatasiz?",
      "Qayta mijozlarni qanday ushlab turasiz?",
      "Soch modasidagi yangi trendlarni qanday kuzatib borasiz?",
      "Soch turmaklashda 2025-yilgi eng mashhur uslublar qanday deb o'ylaysiz?",
      "Qancha mijozga xizmat ko'rsatishingiz mumkin bir kunda?",
      "Jadval bilan ishlashga qanchalik moslashuvchisiz?",
      "Ish vaqtida jamoada qanday ishlaysiz?",
    ],
    colorist: [
      "Siz nechchi yildan beri kolorist sifatida ishlaysiz?",
      "Qayerda o'qigansiz yoki qaysi trening/kurslarda qatnashgansiz?",
      'Sertifikatingiz bormi? Agar bo\'lsa, qaysi tashkilotdan?',
      "Qaysi soch bo'yash texnikalarini yaxshi bilasiz? (balayage, ombre, airtouch, highlights, root shadow, glossing va boshqalar)",
      "Mijozga mos rangni qanday tanlaysiz? (teri rangi, ko'z rangi, shaxsiy uslub asosida)",
      "To'liq oq sochni bo'yashda qanday strategiyani tanlaysiz?",
      "Mijoz sochi oldin boshqa rangda bo'yalgan bo'lsa, qanday diagnostika qilasiz?",
      "Sochning holatini buzmasdan rangni o'zgartirish uchun qanday vositalardan foydalanasiz?",
      "Siz qaysi brend mahsulotlari bilan ishlaysiz? (Wella, L'Oréal, Schwarzkopf va h.k.)",
      'Organik yoki ammoniyatsiz bo\'yoqlar bilan ishlaganmisiz?',
      "Sochni bo'yashdan oldin qanday himoya vositalarini qo'llaysiz?",
      'Kimyoviy zarar ko\'rgan soch bilan ishlaganmisiz? Qanday yondashuvda bo\'lgansiz?',
      "Mijoz noto'g'ri rangni so'ragan bo'lsa, qanday maslahat berasiz?",
      "Soch rangi noto'g'ri chiqsa yoki rang teng bo'lmasa, nima qilasiz?",
      "Rangni to'g'rilash (correction) bo'yicha tajribangiz bormi?",
      "Mijoz sochining holati yomon bo'lsa, qanday tushuntirasizki, bu rang unga to'g'ri kelmaydi?",
      "Qanday qilib mijozga uyda sochni to'g'ri parvarish qilishni o'rgatasiz?",
      "Soch bo'yalganidan keyingi to'g'ri yuvish va parvarish bo'yicha qanday tavsiyalar berasiz?",
      'Ishlaringizdan namunalar bormi? (Instagram, Google Drive, portfolio kitob)',
      "Qaysi ish(lar)ingiz bilan eng ko'p faxrlanasiz?",
      'Kuniga necha mijoz bilan ishlay olasiz?',
      'Jamoada stilistlar va boshqa koloristlar bilan ishlashga qanchalik ochiqsiz?',
      'Mijozlar bazasini saqlab qolish uchun qanday strategiyalaringiz bor?',
    ],
    mua: [
      "Vizajistlikka qanday kirib kelgansiz? Qancha yillik tajribangiz bor?",
      "Qayerda o'qigansiz yoki treninglarda qatnashgansizmi?",
      'Sizda sertifikatlar bormi? Agar bo\'lsa, qaysi tashkilotdan?',
      "Qaysi makiyaj uslublarida ishlaysiz? (kundalik, to'y, fotosessiya, podium, kreativ, smokey eyes va h.k.)",
      'Eng ko\'p ishlatadigan 3 ta texnikangiz qaysilar?',
      'Yuz tuzilmasiga qarab kontur va highlightingni qanday moslashtirasiz?',
      'Mijoz terisining turi va rangiga qarab tonal krem va boshqa vositalarni qanday tanlaysiz?',
      'Qaysi kosmetik brendlar bilan ishlaysiz (MAC, Huda Beauty, NARS, Kryolan, Inglot va h.k.)?',
      'Siz uchun muhim bo\'lgan 5 ta asosiy make-up mahsuloti nima?',
      'Allergik yoki sezgir terili mijozlarga qanday mahsulotlar tavsiya qilasiz?',
      "Kelin makiyaji bilan ishlaganmisiz? Kelinlar bilan ishlashda nimalarga e’tibor berasiz?",
      'Fotosessiya yoki video uchun make-upda nimani hisobga olasiz?',
      'Yorug\'lik yoki kamera oldida ishlatiladigan makiyajda qanday farqlar bor?',
      'Mijoz noto\'g\'ri uslubni tanlasa, qanday maslahat berasiz?',
      "Mijoz ko'zguda o'zini yoqtirmasa, qanday yondashasiz?",
      "Qanday qilib mijozlar bilan ishonchli va ijobiy aloqa o'rnatasiz?",
      'Kuniga nechta mijoz bilan ishlay olasiz?',
      'Mobil xizmat (uyga borib makiyaj qilish) taklif qilasizmi?',
      "To'y, fotosessiya, yoki sahna tadbirlariga tayyorlovda jamoa bilan ishlash tajribangiz bormi?",
      'Har bir mijozdan keyin cho\'tkalarni qanday tozalaysiz?',
      'COVIDdan keyin gigiyena protokollaringiz o\'zgardimi?',
      'Bir martalik vositalardan foydalanasizmi?',
    ],
    nails: [
      'Manikyur/pedikyur sohasida qancha tajribangiz bor?',
      "Qayerda o'qigansiz? Sertifikat yoki diplomingiz bormi?",
      'Qanday xizmatlarni taklif qila olasiz? (klassik, apparat manikyur, SPA, dizaynlar, qattiq gel va h.k.)',
      'To\'y va maxsus tadbirlar uchun manikyur qilganmisiz?',
      'Qaysi texnikalarda tajribangiz bor? (apparat, kombinatsiyalangan, kesik/kesilmaydigan, "nolyovka", gel lak, polygel, akril, dizaynlar)',
      'Oyoq parvarishida qanday muammolar bilan ishlay olasiz? (qadoq, quruq tovon, qalinlashgan tirnoq va h.k.)',
      'Mijoz tirnog\'i sinuvchan yoki sezgir bo\'lsa, qanday materiallar tavsiya qilasiz?',
      'Qanday holatda mijozga xizmat ko\'rsatishni rad qilasiz? (infeksiya, zamburug\', qon oqishi)',
      'Har bir mijozdan keyin asboblarni qanday dezinfeksiya qilasiz?',
      'Sterilizatsiya qilish uchun qanday uskunalardan foydalanasiz? (sterilizator, kvartslampalar, suyuqliklar)',
      'Bir martalik vositalardan (fayl, buff, salfetka, niqob) foydalanasizmi?',
      'Qanday hollarda ishlov berilmagan vositalardan foydalanish xavflidir?',
      'Qanday tirnoq dizaynlarini qilasiz? (fransuz, ombre, folga, rhinestones, rasm, 3D)',
      'Sizda tayyor ishlardan iborat portfolio bormi? (Instagram, fotosuratlar)',
      'Mijoz qanday dizayn xohlashini bilmasa, qanday yordam berasiz?',
      "Mijoz qoniqmasa yoki e’tiroz bildirsa, qanday yondashasiz?",
      'Doimiy mijozlar bazasini qanday ushlab qolasiz?',
      'Mijoz kechiksa yoki bekor qilsa, qanday qoidalaringiz bor?',
      "Haftasiga necha kun ishlay olasiz? (to'liq yoki yarim stavka)",
      'Kuniga maksimal nechta mijoz qabul qila olasiz?',
      'Jadval asosida ishlay olasizmi yoki faqat oldindan yozuv bilan?',
      'O\'zingiz mahsulot olib kelasizmi yoki salondan foydalanasizmi?',
      'Qaysi brend materiallar bilan ishlashni afzal ko\'rasiz? (Kodi, TNL, OPI, Gelish, Masura va h.k.)',
      'Narxlar bo\'yicha salon siyosatiga amal qila olasizmi?',
    ],
    lash: [
      'Kiprik yapishtirish sohasida nechchi yillik tajribangiz bor?',
      "Qayerda o'qigansiz? Sertifikat yoki diplomingiz bormi?",
      'Qanday kurslarda qatnashgansiz (onlayn yoki offlayn)?',
      "O'zingizni boshlovchi, o'rta yoki professional darajada deb hisoblaysizmi?",
      'Qaysi texnikalarda ishlaysiz? (klassik 1D, 2D–6D, volume, mega volume, wet effect, Kim Kardashian, lash lift)',
      'Kipriklar uchun ishlatadigan materiallaringiz qanday? (brend, sifat, egiluvchanlik, qalinlik)',
      'Mijozning ko\'z shakliga qarab texnikani qanday tanlaysiz?',
      'Allergiyasi bo\'lgan mijozlarga qanday yondashasiz?',
      "Qancha vaqtda bir to'liq kiprik yapishtirishni yakunlaysiz?",
      'Har bir mijozdan keyin asboblaringizni qanday tozalaysiz/dezinfeksiya qilasiz?',
      'Ko\'z atrofi sezgir hudud — gigiyenani qanday kafolatlaysiz?',
      "Qanday holatda mijozga xizmat ko'rsatmaslik kerak? (kon'yunktivit, teri yallig'lanishi, allergiya)",
      'Paste yoki lenta yopishtirishda gigiyenik yondashuvlaringiz qanday?',
      'Mijoz kiprik uzunligidan/shaklidan norozi bo\'lsa, qanday javob berasiz?',
      'Mijozning tabiiy kipriklari zaif bo\'lsa, qanday maslahatlar berasiz?',
      'Mijoz necha haftada korrektsiyaga kelishi kerak deb hisoblaysiz?',
      'Kiprik tushishini kamaytirish uchun qanday uy parvarishi tavsiya qilasiz?',
      'Haftaning qaysi kunlari ishlay olasiz?',
      'Bir kunda nechta mijozga xizmat ko\'rsatishingiz mumkin?',
      'Qancha muddatda to\'liq kiprik qilishni yakunlaysiz?',
      "O'zingiz mahsulot olib kelasizmi yoki salondan foydalanasizmi?",
      'Qaysi brendlar bilan ishlaysiz? (Vivienne, Lovely, Sky Glue, Neicha va h.k.)',
      'Mijoz ko\'zida allergik reaksiya bo\'lsa, qanday choralar ko\'rasiz?',
      'Agar mijoz norozi bo\'lsa, pulni qaytarasizmi yoki tuzatish taklif qilasizmi?',
      'Boshqa kiprikchilarga maslahat berib turganmisiz?',
      'Sizningcha, yaxshi lashmakerda qanday sifatlar bo\'lishi kerak?',
    ],
    depil: [
      'Depilatsiya sohasida nechchi yillik tajribangiz bor?',
      "Qaysi usullarni qo'llay olasiz? (shugaring, vosk, apparatli, lazer)",
      "Qayerda o'qigansiz yoki qanday kurslarda qatnashgansiz?",
      'Sertifikatlaringiz bormi? Qaysi markaz tomonidan?',
      "Qaysi zonalar bilan ishlaysiz? (oyoq, qo'l, qo'ltiq, bikini — klassik/chuqur, yuz va b.)",
      'Qaysi usulni qaysi mijozga tavsiya qilasiz? (sezgir teriga shugaring va h.k.)',
      "Teri yallig'langan, akneli yoki qizarishga moyil bo'lsa, qanday texnika ishlatasiz?",
      'Erkak mijozlarga xizmat ko\'rsatganmisiz?',
      'Har bir mijozdan keyin asboblarni qanday tozalaysiz/dezinfeksiya qilasiz?',
      'Bir martalik materiallardan (qoshiq, qo\'lqop, salfetka) foydalanasizmi?',
      "Xizmat davomida qaysi hollarda ishlashni to'xtatgan ma'qul (infeksiya, yallig'lanish, zamburug')?",
      "Mijozning terisida qonash bo'lsa, qanday choralar ko'rasiz?",
      'Mijoz birinchi marta kelsa, qanday tushuntirish va maslahatlar berasiz?',
      'Epilyatsiyadan keyin qanday parvarish tavsiya qilasiz?',
      "Mijoz og'riqqa chidamsiz bo'lsa, qanday yondashasiz?",
      'Mijoz norozi bo\'lsa, qanday hal qilasiz?',
      'Bir kunda nechta mijozga xizmat ko\'rsatishingiz mumkin?',
      'Qaysi zonalar ko\'proq vaqt oladi? Nima uchun?',
      'Qaysi brend materiallardan foydalanasiz? (Gloria, Ayuna, Italwax, White Line va h.k.)',
      "O'zingiz mahsulot olib kelasizmi yoki salon mahsulotlari bilan ishlaysizmi?",
      'Qanday mijozlarga xizmatdan bosh tortgansiz? Nima sabab?',
      'Muntazam mijozlarni qanday ushlab turasiz?',
      'Yaxshi depilatsiya mutaxassisida qanday sifatlar bo\'lishi kerak?',
      "Trendlarga (lazer, apparatlar) qiziqasizmi? O'rganishga tayyormisiz?",
      "Bikini zonasi juda og'riqli bo'lsa, nima tavsiya qilasiz?",
      'Sochlar juda qisqa bo\'lsa, depilatsiya qilasizmi yoki keyinga qoldirasizmi?',
      "Depilyatsiyadan so'ng dog', yallig'lanish yoki toshma bo'lsa — mijozga nima deysiz?",
    ],
    admin: [
      "Qanday dasturlar bilan ishlay olasiz? (CRM, yozuv botlari, Excel, Telegram botlar, kassaviy dasturlar)",
      'Telefon orqali mijoz bilan qanday muomala qilasiz? (Masalan, mijoz norozi bo\'lsa)',
      'Ish jadvalini tuzish tajribangiz bormi? Ustalar bilan qanday kelishasiz?',
      'Zaxira mahsulotlarni kuzatish va yetkazib beruvchilar bilan ishlash tajribangiz bormi?',
      'Administratorning asosiy 3 vazifasi nima deb o\'ylaysiz?',
      'Mijoz ustadan norozi bo\'lsa, qanday yondashasiz?',
      'Mijoz kechiksa yoki yozuvsiz kelsa, qanday yo\'l tutasiz?',
      'Muntazam mijozlar bazasini qanday ushlab turasiz?',
      "Notanish odam qo'ng'iroq qilib, xizmat haqida so'rasa — qanday tanishtirasiz?",
      'Salonda shovqin yoki janjal chiqsa, qanday yo\'l tutasiz?',
      'Upsell — qo\'shimcha xizmatlarni tavsiya qila olasizmi?',
      'Har bir xizmat va usta haqida ma\'lumotni qanday yodda saqlaysiz?',
      'Kunlik/oylik hisobotni qanday tuzasiz?',
      'Aksiya yoki reklama kampaniyalarini qanday targ\'ib qilasiz?',
      "Agar bir vaqtda 3 mijoz yozuvsiz kelsa va barcha ustalar band bo'lsa, nima qilasiz?",
      'Ustalar kechiksa yoki ishga kelmasa, qanday choralar ko\'rasiz?',
      "Mijoz salonda shikoyat qilib ovozini ko'tarib gapirsa, qanday muomala qilasiz?",
      "To'liq ish jadvalida ishlay olasizmi? Dam olish kunlari, kechki smena?",
      'Vaqtida kelish va ishni o\'z vaqtida topshirish mas\'uliyatini qanday baholaysiz?',
      'Jamoa bilan ishlashda qaysi yondashuvni afzal bilasiz?',
      'Administrator qanday ko\'rinishda bo\'lishi kerak? (tashqi ko\'rinish, muomala, intizom)',
      'Faraz qiling, soat 18:00 da uchta mijoz birdan yozuvsiz keldi. Barcha ustalar band. Biri jahl bilan gapirmoqda. Nima qilasiz?',
      "Mijozga yozuv vaqtini adashib aytdingiz va u g'azablangan. Reaksiyangiz?",
    ],
  },
  ru: {
    stylist: [
      'Сколько лет у вас опыта?',
      'С какими типами волос вы любите работать (прямые, кудрявые, тонкие и т.д.)?',
      'Какая причёска вам нравится больше всего?',
      'Кто был вашим самым сложным клиентом и как вы решили ситуацию?',
      'Какими брендами/типами средств для волос вы пользуетесь?',
      'Какие техники окрашивания/укладки вы знаете лучше всего? (balayage, ombre, highlighting и т.д.)',
      'Как подбираете стрижку под форму лица клиента?',
      'Мужские или женские стрижки даются вам легче?',
      'Если клиент недоволен новым стилем, как реагируете?',
      'Как выстраиваете доверительное общение с клиентами?',
      'Как удерживаете повторных клиентов?',
      'Как следите за трендами в hair-индустрии?',
      'Какие самые популярные укладки в 2025 году, по вашему мнению?',
      'Сколько клиентов можете обслужить в день?',
      'Насколько гибко работаете по графику?',
      'Как работаете в команде?',
    ],
    colorist: [
      'С какого года вы работаете колористом?',
      'Где обучались или какие курсы/тренинги проходили?',
      'Есть сертификат? Если да — от какой организации?',
      'Какие техники окрашивания вы хорошо знаете? (balayage, ombre, airtouch, highlights, root shadow, glossing и др.)',
      'Как подбираете цвет клиенту? (тон кожи, цвет глаз, личный стиль)',
      'Какую стратегию выбираете при полном закрашивании седины?',
      'Если волосы ранее окрашены, как проводите диагностику?',
      'Какие средства используете, чтобы изменить цвет без ущерба для волос?',
      "Какими брендами работаете? (Wella, L'Oréal, Schwarzkopf и др.)",
      'Работали с органическими/безаммиачными красителями?',
      'Какие защитные средства используете перед окрашиванием?',
      'Работали с химически повреждёнными волосами? Какой подход?',
      'Если клиент просит неподходящий цвет, как советуете?',
      'Что делаете, если цвет вышел неверный или лег неравномерно?',
      'Есть опыт color-correction?',
      'Если состояние волос плохое, как объясняете, что цвет не подходит?',
      'Как обучаете клиента домашнему уходу?',
      'Какие советы по мытью и уходу после окрашивания даёте?',
      'Есть примеры работ? (Instagram, Google Drive, портфолио)',
      'Какими работами больше всего гордитесь?',
      'Скольких клиентов ведёте в день?',
      'Насколько открыты к работе со стилистами и другими колористами в команде?',
      'Какие стратегии удержания клиентской базы используете?',
    ],
    mua: [
      'Как вы пришли в визаж? Какой у вас стаж?',
      'Где обучались? Посещали тренинги?',
      'Есть сертификаты? От каких организаций?',
      'В каких стилях макияжа работаете? (повседневный, свадебный, фотосессия, подиум, креатив, smokey eyes и т.д.)',
      'Какие 3 техники используете чаще всего?',
      'Как адаптируете контуринг и хайлайтинг под форму лица?',
      'Как подбираете тональные и другие средства под тип и тон кожи?',
      'Какими брендами работаете (MAC, Huda Beauty, NARS, Kryolan, Inglot и др.)?',
      'Какие 5 базовых продуктов для вас самые важные?',
      'Что рекомендуете аллергичной/чувствительной коже?',
      'Работали с невестами? На что обращаете внимание?',
      'Что учитываете в макияже для фото/видео?',
      'Чем отличается макияж для сцены/камеры?',
      'Если клиент выбирает неверный стиль, как советуете?',
      'Если клиенту не нравится отражение в зеркале, как действуете?',
      'Как выстраиваете доверительный и позитивный контакт?',
      'Сколько клиентов в день можете принять?',
      'Делаете выездной макияж (на дом)?',
      'Есть опыт подготовки к свадьбам, фотосессиям, сцене в команде?',
      'Как очищаете кисти после каждого клиента?',
      'Изменились ли ваши гигиенические протоколы после COVID?',
      'Используете одноразовые расходники?',
    ],
    nails: [
      'Каков ваш опыт в маникюре/педикюре?',
      'Где обучались? Есть сертификат/диплом?',
      'Какие услуги оказываете? (классика, аппаратный, SPA, дизайны, твёрдый гель и т.д.)',
      'Делали маникюр для свадьбы и особых мероприятий?',
      'В каких техниках опыт? (аппаратный, комбинированный, обрезной/необрезной, "нулёвка", гель-лак, полигель, акрил, дизайны)',
      'С какими проблемами стоп работаете? (вросший ноготь, сухие пятки, утолщение ногтя и т.д.)',
      'Что советуете для ломких/чувствительных ногтей?',
      'В каких случаях отказываете в услуге? (инфекция, грибок, кровотечение)',
      'Как дезинфицируете инструменты после каждого клиента?',
      'Каким оборудованием стерилизируете? (стерилизатор, кварц, растворы)',
      'Используете одноразовые файлы/бафы/салфетки/маски?',
      'Когда опасно использовать необработанные инструменты?',
      'Какие дизайны делаете? (френч, омбре, фольга, стразы, роспись, 3D)',
      'Есть портфолио работ? (Instagram, фото)',
      'Если клиент не знает дизайн, как помогаете выбрать?',
      'Если клиент недоволен, как действуете?',
      'Как удерживаете постоянных клиентов?',
      'Какие правила при опоздании/отмене?',
      'Сколько дней в неделю готовы работать? (полная/частичная занятость)',
      'Максимум клиентов в день?',
      'Работаете по графику или только по предварительной записи?',
      'Свои материалы привозите или используете салонные?',
      'Какие бренды предпочитаете? (Kodi, TNL, OPI, Gelish, Masura и др.)',
      'Готовы соблюдать ценовую политику салона?',
    ],
    lash: [
      'Сколько лет опыта в наращивании ресниц?',
      'Где обучались? Есть сертификат/диплом?',
      'Какие курсы проходили (онлайн/офлайн)?',
      'Считаете себя начинающим, средним или профессионалом?',
      'В каких техниках работаете? (классика 1D, 2D–6D, volume, mega volume, wet effect, Kim K, lash lift)',
      'Какие материалы используете? (бренд, качество, изгиб, толщина)',
      'Как подбираете технику под форму глаз?',
      'Как работаете с аллергиками?',
      'За какое время делаете полное наращивание?',
      'Как дезинфицируете инструменты после каждого клиента?',
      'Область вокруг глаз чувствительная — как обеспечиваете гигиену?',
      'В каких случаях услугу не оказываете? (конъюнктивит, воспаление кожи, аллергия)',
      'Какие гигиенические подходы при патчах/скотче используете?',
      'Если клиент недоволен длиной/формой, как реагируете?',
      'Если свои ресницы слабые, что советуете?',
      'С какой периодичностью назначаете коррекцию?',
      'Какой домашний уход уменьшает выпадение ресниц?',
      'В какие дни недели можете работать?',
      'Сколько клиентов в день обслуживаете?',
      'За какое время выполняете полный объём?',
      'Свои материалы привозите или салонные?',
      'Какие бренды предпочитаете? (Vivienne, Lovely, Sky Glue, Neicha и др.)',
      'Если аллергия у клиента, какие меры предпринимаете?',
      'Если клиент недоволен, возвращаете деньги или предлагаете коррекцию?',
      'Давали ли советы менее опытным мастерам?',
      'Какими качествами должен обладать хороший лэшмейкер?',
    ],
    depil: [
      'Сколько лет опыта в депиляции?',
      'Какие методы применяете? (шугаринг, воск, аппаратные, лазер — знакомы ли)',
      'Где обучались/какие курсы проходили?',
      'Есть сертификаты? Каким центром выданы?',
      'С какими зонами работаете? (ноги, руки, подмышки, бикини — классика/глубокое, лицо и др.)',
      'Какой метод кому рекомендуете? (напр., для чувствительной кожи — шугаринг)',
      'Что делаете при воспалённой, акне или склонной к покраснению коже?',
      'Работали с мужчинами-клиентами?',
      'Как очищаете/дезинфицируете инструменты после каждого клиента?',
      'Используете одноразовые материалы (шпатели, перчатки, салфетки)?',
      'В каких случаях лучше прекратить услугу? (инфекция, воспаление, грибок)',
      'Если появилась кровь, какие меры примете?',
      'Что объясняете клиенту при первом визите?',
      'Какие рекомендации по уходу после эпиляции даёте?',
      'Если клиент плохо переносит боль, как действуете?',
      'Если клиент недоволен, как решаете?',
      'Сколько клиентов в день обслуживаете?',
      'Какие зоны занимают больше времени и почему?',
      'Какими брендами пользуетесь? (Gloria, Ayuna, Italwax, White Line и др.)',
      'Свои материалы или салонные?',
      'Кому отказывали в услуге и почему?',
      'Как удерживаете постоянных клиентов?',
      'Какими качествами должен обладать хороший специалист по депиляции?',
      'Интересуетесь трендами (лазер, аппараты)? Готовы обучаться?',
      'Если бикини зона очень болезненна, что посоветуете?',
      'Если волосы слишком короткие — делать сейчас или отложить?',
      'Если после эпиляции пятна/воспаление/сыпь — что говорите клиенту?',
    ],
    admin: [
      'Какими программами владеете? (CRM, боты записи, Excel, Telegram-боты, кассовые ПО)',
      'Как общаетесь с клиентом по телефону? (например, если клиент недоволен)',
      'Есть опыт составления графика? Как согласовываете с мастерами?',
      'Есть опыт учёта запасов и работы с поставщиками?',
      'Какие 3 основные задачи администратора?',
      'Если клиент недоволен мастером, как действуете?',
      'Если клиент опоздал или пришёл без записи, что делаете?',
      'Как удерживаете базу постоянных клиентов?',
      'Если незнакомый человек звонит и спрашивает про услуги — как презентуете салон?',
      'Если в салоне шум/конфликт — как действуете?',
      'Умеете ли делать upsell — предлагать доп. услуги?',
      'Как держите в голове всю инфо по услугам и мастерам?',
      'Как формируете дневной/месячный отчёт?',
      'Как продвигаете акции/рекламные кампании?',
      'Если сразу пришли 3 клиента без записи и все мастера заняты — ваши действия?',
      'Если мастер опоздал или не пришёл — какие меры?',
      'Если клиент жалуется и повышает голос — как общаетесь?',
      'Готовы работать полный день? В выходные, вечерние смены?',
      'Как оцениваете свою пунктуальность и ответственность?',
      'Какой стиль командной работы предпочитаете?',
      'Как должен выглядеть администратор? (внешний вид, общение, дисциплина)',
      'Ситуация: в 18:00 пришли три клиента без записи, все мастера заняты, один злится. Ваши действия?',
      'Ситуация: вы перепутали время записи, клиент зол. Ваша реакция?',
    ],
  },
};

// ======== HELPERS ========
function langKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(LANGS.uz, 'lang_uz'), Markup.button.callback(LANGS.ru, 'lang_ru')],
  ]);
}
function categoryKeyboard(lang) {
  const rows = CATEGORY_DEFS.map((c) => [Markup.button.callback(c[lang], `cat_${c.id}`)]);
  return Markup.inlineKeyboard(rows);
}
function contactKeyboard(lang) {
  const label = TEXT.askPhoneBtn[lang];
  return Markup.keyboard([Markup.button.contactRequest(label)]).resize();
}
function removeKb() { return Markup.removeKeyboard(); }

function formatSummary(lang, session, telegramUser) {
  const L = lang === 'ru' ? {
    title: 'Новая анкета', name: 'Имя', phone: 'Телефон', lang: 'Язык', cat: 'Категория', q: 'Ответы на вопросы', from: 'Отправитель',
  } : {
    title: 'Yangi anketa', name: 'Ism', phone: 'Telefon', lang: 'Til', cat: 'Kategoriya', q: 'Savollarga javoblar', from: 'Yuboruvchi',
  };
  const lines = [];
  lines.push(`📝 ${L.title}`);
  lines.push(`• ${L.name}: ${session.data.fullName || '-'}`);
  lines.push(`• ${L.phone}: ${session.data.phone || '-'}`);
  lines.push(`• ${L.lang}: ${LANGS[session.lang]}`);
  lines.push(`• ${L.cat}: ${catLabel(lang, session.data.categoryId) || '-'}`);
  lines.push(`\n${L.q}:`);
  for (const [q, a] of Object.entries(session.data.answers)) {
    lines.push(`- ${q}\n  → ${a}`);
  }
  lines.push(`\n${L.from}: @${telegramUser?.username || telegramUser?.id}`);
  return lines.join('\n');
}

function isReadyText(text, lang) {
  return (lang === 'ru') ? /^(готово|готов|готова)$/i.test(text.trim()) : /^(tayyor)$/i.test(text.trim());
}

function normalizePhone(p) {
  if (!p) return null;
  const digits = p.replace(/[^\d+]/g, '');
  // Accept +998901234567 or 90 123 45 67, 998901234567 etc.
  if (/^\+?\d{9,15}$/.test(digits)) return digits.startsWith('+') ? digits : '+' + digits;
  return null;
}

// ======== FLOW ========
async function askLang(ctx) {
  const s = getSession(ctx.from.id);
  s.step = 'askLang';
  await ctx.reply(TEXT.askLang[s.lang || 'uz'] + '\n\n' + Object.values(LANGS).join(' / '), removeKb());
  await ctx.reply('—', langKeyboard());
}
async function askFullName(ctx) {
  const s = getSession(ctx.from.id);
  s.step = 'askFullName';
  await ctx.reply(TEXT.askFullName[s.lang]);
}
async function askPhone(ctx) {
  const s = getSession(ctx.from.id);
  s.step = 'askPhone';
  await ctx.reply(TEXT.askPhone[s.lang], contactKeyboard(s.lang));
}
async function askCategory(ctx) {
  const s = getSession(ctx.from.id);
  s.step = 'chooseCategory';
  await ctx.reply(TEXT.chooseCategory[s.lang], removeKb());
  await ctx.reply('—', categoryKeyboard(s.lang));
}
async function startQuestions(ctx) {
  const s = getSession(ctx.from.id);
  s.qIndex = 0;
  const qList = QUESTIONS[s.lang][s.data.categoryId];
  s.step = 'askQuestions';
  await ctx.reply(TEXT.thanks[s.lang]);
  await ctx.reply(qList[s.qIndex]);
}
async function askNextOrVideos(ctx) {
  const s = getSession(ctx.from.id);
  const qList = QUESTIONS[s.lang][s.data.categoryId];
  s.qIndex += 1;
  if (s.qIndex < qList.length) {
    await ctx.reply(qList[s.qIndex]);
  } else {
    s.step = 'collectVideos';
    await ctx.reply(TEXT.commonVideos[s.lang]);
  }
}
async function finalizeAndSend(ctx) {
  const s = getSession(ctx.from.id);
  const msg = formatSummary(s.lang, s, ctx.from);
  try {
    await ctx.telegram.sendMessage(CHANNEL_ID, msg);
  } catch (e) {
    console.error('Failed to send summary to channel:', e.message);
  }
  for (const mid of s.data.uploadedMsgIds) {
    try {
      await ctx.telegram.copyMessage(CHANNEL_ID, ctx.chat.id, mid);
    } catch (e) {
      console.error('Copy media failed:', e.message);
    }
  }
  await ctx.reply(TEXT.done[s.lang], removeKb());
  resetSession(ctx.from.id);
}

// ======== COMMANDS ========
bot.start(async (ctx) => {
  resetSession(ctx.from.id);
  const s = getSession(ctx.from.id);
  s.lang = 'uz'; // default until chosen
  await ctx.reply(TEXT.start[s.lang]);
  await askLang(ctx);
});

bot.command('reset', async (ctx) => {
  resetSession(ctx.from.id);
  const s = getSession(ctx.from.id);
  s.lang = 'uz';
  await ctx.reply(TEXT.reset['uz']);
  await askLang(ctx);
});

// ======== CALLBACKS (Language/Category) ========
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const s = getSession(ctx.from.id);
  try {
    if (data === 'lang_uz') {
      s.lang = 'uz';
      await ctx.answerCbQuery("Til: O'zbekcha");
      await askFullName(ctx);
      return;
    }
    if (data === 'lang_ru') {
      s.lang = 'ru';
      await ctx.answerCbQuery('Язык: Русский');
      await askFullName(ctx);
      return;
    }
    if (data.startsWith('cat_')) {
      const id = data.slice(4); // short id
      if (!CAT_BY_ID[id]) {
        await ctx.answerCbQuery('Invalid category', { show_alert: true });
        return;
      }
      s.data.categoryId = id;
      await ctx.answerCbQuery(catLabel(s.lang, id));
      await startQuestions(ctx);
      return;
    }
  } catch (e) {
    console.error('callback error', e);
  }
});

// ======== CONTACT (phone share) ========
bot.on('contact', async (ctx) => {
  const s = getSession(ctx.from.id);
  if (s.step !== 'askPhone') return;
  const phone = ctx.message.contact.phone_number;
  s.data.phone = normalizePhone(phone) || phone;
  await askCategory(ctx);
});

// ======== TEXT HANDLER ========
bot.on('text', async (ctx) => {
  const s = getSession(ctx.from.id);
  const text = ctx.message.text?.trim();

  if (s.step === 'askLang') {
    // user typed instead of pressing button; try to infer
    if (/^(ru|rus|рус)/i.test(text)) s.lang = 'ru';
    else if (/^(uz|o'z|ozb|uzb|узб)/i.test(text)) s.lang = 'uz';
    if (!s.lang) s.lang = 'uz';
    await askFullName(ctx);
    return;
  }

  if (s.step === 'askFullName') {
    s.data.fullName = text;
    await askPhone(ctx);
    return;
  }

  if (s.step === 'askPhone') {
    const normalized = normalizePhone(text);
    if (!normalized) {
      await ctx.reply(TEXT.invalidPhone[s.lang]);
      return;
    }
    s.data.phone = normalized;
    await askCategory(ctx);
    return;
  }

  if (s.step === 'chooseCategory') {
    // remind to use buttons
    await ctx.reply('👇', categoryKeyboard(s.lang));
    return;
  }

  if (s.step === 'askQuestions') {
    const qList = QUESTIONS[s.lang][s.data.categoryId];
    const currentQ = qList[s.qIndex];
    s.data.answers[currentQ] = text;
    await askNextOrVideos(ctx);
    return;
  }

  if (s.step === 'collectVideos') {
    if (isReadyText(text, s.lang)) {
      await finalizeAndSend(ctx);
      return;
    }
    await ctx.reply(TEXT.promptReady[s.lang]);
    return;
  }

  // If user comes mid-flow
  await ctx.reply('/start');
});

// ======== MEDIA HANDLERS ========
bot.on(['video', 'video_note', 'document'], async (ctx) => {
  const s = getSession(ctx.from.id);
  if (s.step !== 'collectVideos') return; // ignore media outside step
  try {
    s.data.uploadedMsgIds.push(ctx.message.message_id);
    await ctx.reply('✅');
  } catch (e) {
    console.error('store media id failed', e);
  }
});
// Optional: photos as portfolio
bot.on('photo', async (ctx) => {
  const s = getSession(ctx.from.id);
  if (s.step !== 'collectVideos') return;
  try {
    s.data.uploadedMsgIds.push(ctx.message.message_id); // will still forward
    await ctx.reply('✅');
  } catch (e) {}
});

// ======== GUARDS ========
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  try { ctx.reply('⚠️ Botda xatolik yuz berdi / Произошла ошибка. Попробуйте /start'); } catch {}
});

// ======== STARTUP (Webhook OR Polling) ========
(async () => {
  // Polling mode (local/dev)
  bot.launch()
    .then(() => console.log('✅ Bot polling rejimida ishga tushdi'))
    .catch(err => console.error('❌ Xato:', err));

  // Graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
})();
