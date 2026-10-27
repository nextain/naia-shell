export const APP_LOCALES = ["ar","bn","de","en","es","fr","hi","id","ja","ko","pt","ru","vi","zh"] as const;
export type AppLocale = (typeof APP_LOCALES)[number];
const copies = {
  "ar": {
    "title": "تاروت كافيه لوا",
    "stories": "القصص",
    "mute": "كتم الموسيقى وصوت البطاقة",
    "unmute": "تشغيل الموسيقى وصوت البطاقة",
    "upright": "مستقيمة",
    "reversed": "مقلوبة",
    "intro": "تصبح نايا قارئة تاروت كافيه لوا: أخبرها بما يشغلك فتقرأ البطاقات واحدة تلو الأخرى. ويضم التطبيق كتاب حكايات التاروت الذي تقرؤه نايا بصوت عالٍ.",
    "help": "أخبر نايا بما يشغلك في المحادثة، فتضع البطاقات وتقرأها واحدة تلو الأخرى. افتح الكتاب من الزر أعلى اليمين واطلب منها القراءة بصوت عالٍ."
  },
  "bn": {
    "title": "ক্যাফে লুয়া ট্যারোট",
    "stories": "গল্প",
    "mute": "সঙ্গীত ও কার্ডের শব্দ বন্ধ করুন",
    "unmute": "সঙ্গীত ও কার্ডের শব্দ চালু করুন",
    "upright": "সোজা",
    "reversed": "উল্টো",
    "intro": "নায়া ক্যাফে লুয়ার ট্যারোট পাঠক হয়ে আপনার কথা শোনে এবং একে একে কার্ড পড়ে। অ্যাপে ক্যাফে লুয়ার ট্যারোট গল্পের বইও আছে, যা নায়া পড়ে শোনায়।",
    "help": "কথোপকথনে নায়াকে আপনার চিন্তার কথা বলুন। সে একে একে কার্ড পড়বে। উপরের ডান দিকের বই বোতামে গল্প খুলে নায়াকে পড়ে শোনাতে বলুন।"
  },
  "de": {
    "title": "Cafe Lua Tarot",
    "stories": "Geschichten",
    "mute": "Musik und Kartenton stummschalten",
    "unmute": "Musik und Kartenton einschalten",
    "upright": "Aufrecht",
    "reversed": "Umgekehrt",
    "intro": "Naia wird zur Tarotleserin von Cafe Lua: Erzähle ihr, was dich beschäftigt, und sie deutet die Karten einzeln. Das Buch Cafe Lua Tarot Stories kann Naia auch vorlesen.",
    "help": "Erzähle Naia im Gespräch von deinem Anliegen. Sie legt die Karten aus und deutet sie einzeln. Öffne das Buch oben rechts und bitte sie vorzulesen."
  },
  "en": {
    "title": "Cafe Lua Tarot",
    "stories": "Stories",
    "mute": "Mute music and card sound",
    "unmute": "Turn on music and card sound",
    "upright": "Upright",
    "reversed": "Reversed",
    "intro": "Naia becomes Cafe Lua's tarot reader: tell her what's on your mind and she reads the cards one by one. The app also holds the Cafe Lua Tarot Stories book, and Naia can read it aloud to you.",
    "help": "Tell Naia what is on your mind in the shell conversation. She lays out the cards and reads them one by one. Open the story book with the book button at the top right and ask her to read aloud."
  },
  "es": {
    "title": "Tarot de Cafe Lua",
    "stories": "Relatos",
    "mute": "Silenciar música y sonido de carta",
    "unmute": "Activar música y sonido de carta",
    "upright": "Al derecho",
    "reversed": "Invertida",
    "intro": "Naia es la tarotista de Cafe Lua: cuéntale lo que te preocupa y leerá las cartas una a una. También puede leer en voz alta el libro de historias del tarot de Cafe Lua.",
    "help": "Cuéntale tu inquietud a Naia en la conversación. Ella extenderá y leerá las cartas una a una. Abre el libro arriba a la derecha y pídele que lea en voz alta."
  },
  "fr": {
    "title": "Tarot Cafe Lua",
    "stories": "Récits",
    "mute": "Couper la musique et le son de carte",
    "unmute": "Activer la musique et le son de carte",
    "upright": "À l’endroit",
    "reversed": "Renversée",
    "intro": "Naia devient la lectrice de tarot de Cafe Lua : confiez-lui vos soucis et elle interprète les cartes une à une. Elle peut aussi lire à voix haute le livre des histoires du tarot de Cafe Lua.",
    "help": "Confiez votre souci à Naia dans la conversation. Elle étale et interprète les cartes une à une. Ouvrez le livre en haut à droite et demandez-lui de lire à voix haute."
  },
  "hi": {
    "title": "कैफ़े लुआ टैरो",
    "stories": "कहानियाँ",
    "mute": "संगीत और कार्ड की ध्वनि बंद करें",
    "unmute": "संगीत और कार्ड की ध्वनि चालू करें",
    "upright": "सीधा",
    "reversed": "उल्टा",
    "intro": "नाया कैफ़े लुआ की टैरो पाठक बनकर आपकी चिंता सुनती है और एक-एक कार्ड पढ़ती है। ऐप में कैफ़े लुआ की टैरो कहानियों की किताब भी है जिसे नाया सुनाती है।",
    "help": "बातचीत में नाया को अपनी चिंता बताएं। वह कार्ड बिछाकर एक-एक पढ़ेगी। ऊपर दाईं ओर किताब खोलें और नाया से पढ़कर सुनाने को कहें।"
  },
  "id": {
    "title": "Tarot Cafe Lua",
    "stories": "Cerita",
    "mute": "Bisukan musik dan bunyi kartu",
    "unmute": "Nyalakan musik dan bunyi kartu",
    "upright": "Tegak",
    "reversed": "Terbalik",
    "intro": "Naia menjadi pembaca tarot Cafe Lua: ceritakan isi pikiranmu dan ia membaca kartu satu per satu. Naia juga dapat membacakan buku Kisah Tarot Cafe Lua.",
    "help": "Ceritakan pikiranmu kepada Naia di percakapan. Ia membuka dan membaca kartu satu per satu. Buka buku di kanan atas dan minta Naia membacakannya."
  },
  "ja": {
    "title": "カフェルア・タロット",
    "stories": "物語",
    "mute": "音楽とカード音をミュート",
    "unmute": "音楽とカード音を再生",
    "upright": "正位置",
    "reversed": "逆位置",
    "intro": "ナイアがカフェルアのタロットリーダーになり、悩みを聞いてカードを一枚ずつ読み解きます。カフェルアのタロット物語の本もナイアが朗読します。",
    "help": "会話欄でナイアに悩みを話してください。ナイアがカードを並べて一枚ずつ読み解きます。右上の本を開き、読んでと頼むと朗読します。"
  },
  "ko": {
    "title": "카페루아 타로",
    "stories": "이야기 책",
    "mute": "배경음악과 카드 소리 끄기",
    "unmute": "배경음악과 카드 소리 켜기",
    "upright": "정방향",
    "reversed": "역방향",
    "intro": "나이아가 카페루아의 타로 리더가 되어 고민을 듣고 카드를 한 장씩 풀어 줍니다. 카페루아 타로 이야기 한 권도 함께 들어 있어, 나이아가 소리 내어 읽어 줍니다.",
    "help": "셸 대화창에서 나이아에게 고민을 말하세요. 나이아가 카드를 펼치고 한 장씩 풀어 줍니다. 이야기 책은 오른쪽 위 책 단추로 열고, '읽어 줘'라고 하면 나이아가 읽어 줍니다."
  },
  "pt": {
    "title": "Tarô Cafe Lua",
    "stories": "Histórias",
    "mute": "Silenciar música e som da carta",
    "unmute": "Ativar música e som da carta",
    "upright": "Em pé",
    "reversed": "Invertida",
    "intro": "Naia é a leitora de tarô do Cafe Lua: conte o que está pensando e ela interpreta as cartas uma a uma. Naia também pode ler em voz alta o livro de histórias de tarô do Cafe Lua.",
    "help": "Conte sua preocupação a Naia na conversa. Ela abrirá e interpretará as cartas uma a uma. Abra o livro no canto superior direito e peça que leia em voz alta."
  },
  "ru": {
    "title": "Таро Cafe Lua",
    "stories": "Рассказы",
    "mute": "Выключить музыку и звук карты",
    "unmute": "Включить музыку и звук карты",
    "upright": "Прямая",
    "reversed": "Перевёрнутая",
    "intro": "Naia становится тарологом Cafe Lua: расскажите о своих заботах, и она истолкует карты по одной. Naia также может прочитать вслух книгу историй таро Cafe Lua.",
    "help": "Расскажите Naia о своей заботе в беседе. Она разложит карты и истолкует их по одной. Откройте книгу кнопкой справа вверху и попросите прочитать вслух."
  },
  "vi": {
    "title": "Tarot Cafe Lua",
    "stories": "Truyện",
    "mute": "Tắt nhạc và âm thanh lá bài",
    "unmute": "Bật nhạc và âm thanh lá bài",
    "upright": "Xuôi",
    "reversed": "Ngược",
    "intro": "Naia trở thành người đọc tarot của Cafe Lua: hãy kể điều bạn băn khoăn để cô ấy giải từng lá bài. Naia cũng có thể đọc to cuốn truyện tarot Cafe Lua.",
    "help": "Hãy kể điều bạn băn khoăn với Naia trong cuộc trò chuyện. Cô ấy trải và giải từng lá bài. Mở sách ở góc trên bên phải và nhờ Naia đọc to."
  },
  "zh": {
    "title": "Cafe Lua 塔罗",
    "stories": "故事",
    "mute": "静音音乐和翻牌声",
    "unmute": "开启音乐和翻牌声",
    "upright": "正位",
    "reversed": "逆位",
    "intro": "Naia 化身 Cafe Lua 的塔罗解读者，倾听你的烦恼并逐张解读卡牌。应用还收录 Cafe Lua 塔罗故事，Naia 可以为你朗读。",
    "help": "在对话中告诉 Naia 你的烦恼。她会摆开卡牌并逐张解读。点击右上角的书打开故事，然后请 Naia 朗读。"
  }
} as const;
export type CopyKey = keyof typeof copies.en;
export function normalizeAppLocale(value: string): AppLocale { const language=value.toLowerCase().split('-')[0]; return APP_LOCALES.includes(language as AppLocale) ? language as AppLocale : 'en'; }
export function copy(locale: AppLocale) { return copies[locale]; }
export function appText(locale: AppLocale, key: CopyKey): string { return copies[locale][key]; }
export function contentLocale(locale: AppLocale): 'ko' | 'en' { return locale === 'ko' ? 'ko' : 'en'; }
