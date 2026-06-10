/**
 * Naia OS Demo — Multilingual narration texts.
 *
 * 25 scenes × 14 languages. Scene IDs match demo-script.ts DEMO_SCENES order.
 * Korean (ko) is the original; others are translated equivalents.
 */

export type NarrationLang =
	| "ko"
	| "en"
	| "ja"
	| "zh"
	| "fr"
	| "de"
	| "ru"
	| "es"
	| "ar"
	| "hi"
	| "bn"
	| "pt"
	| "id"
	| "vi";

export const NARRATIONS: Record<NarrationLang, Record<string, string>> = {
	ko: {
		intro:
			"나이아 OS에 오신 것을 환영합니다. AI 아바타와 함께하는 개인 운영체제, 지금부터 설정을 시작합니다.",
		provider:
			"먼저 AI 제공자를 선택합니다. Gemini, Claude, Grok 등 원하는 LLM을 고를 수 있습니다.",
		apikey:
			"선택한 제공자의 API 키를 입력합니다. 키는 로컬에만 안전하게 저장됩니다.",
		"agent-name":
			'AI 에이전트의 이름을 정해줍니다. 여기서는 "나이아"로 설정하겠습니다.',
		"user-name": "사용자의 이름을 입력합니다. 나이아가 이 이름으로 불러줍니다.",
		character:
			"나이아의 3D 아바타를 선택합니다. VRM 모델을 직접 추가할 수도 있습니다.",
		personality:
			"나이아의 성격을 골라줍니다. 친근한 스타일, 전문가 스타일 등 다양한 옵션이 있습니다.",
		messenger:
			"메신저 연동을 설정할 수 있습니다. 나중에 설정에서도 변경 가능합니다.",
		complete: "설정이 완료되었습니다! 이제 나이아와 대화를 시작해 볼까요?",
		"chat-hello": '"안녕, 나이아!"라고 인사해 보겠습니다.',
		"chat-response":
			"나이아가 반갑게 인사합니다. 실시간 스트리밍으로 응답이 나타납니다.",
		"chat-weather":
			"이번에는 날씨를 물어보겠습니다. 나이아는 스킬을 사용해 실시간 정보를 가져옵니다.",
		"chat-tool-result":
			"도구 실행 결과를 카드로 확인할 수 있습니다. 클릭하면 상세 내용이 펼쳐집니다.",
		"chat-time":
			"시간 스킬도 사용해 보겠습니다. 다양한 내장 스킬을 자유롭게 활용할 수 있습니다.",
		"history-tab":
			"기록 탭에서는 이전 대화 세션을 확인하고 이어서 대화할 수 있습니다.",
		"skills-list":
			"스킬 탭입니다. 날씨, 시간, 메모, 파일 관리 등 다양한 스킬이 설치되어 있습니다.",
		"skills-detail":
			"스킬 카드를 펼치면 상세 설명과 설정을 확인할 수 있습니다.",
		"channels-tab": "채널 탭에서는 디스코드 등 메신저 연동 상태를 관리합니다.",
		"agents-tab":
			"에이전트 탭에서는 실행 중인 에이전트와 세션을 모니터링합니다.",
		"diagnostics-tab":
			"진단 탭에서 게이트웨이, 에이전트, 시스템 상태를 한눈에 확인합니다.",
		"settings-ai":
			"설정 탭입니다. AI 제공자, 모델, API 키를 언제든 변경할 수 있습니다.",
		"settings-voice":
			"음성 설정에서 TTS 음성과 대화 언어를 커스터마이즈합니다.",
		"settings-memory":
			"기억 설정에서 나이아가 기억하는 사실들을 관리할 수 있습니다.",
		"progress-tab":
			"작업 탭에서는 AI 사용량, 비용, 도구 실행 통계를 확인합니다.",
		outro: "나이아 OS, 당신만의 AI 파트너와 함께하세요. 감사합니다.",
	},

	en: {
		intro:
			"Welcome to Naia OS. A personal operating system with your own AI avatar. Let's get started with the setup.",
		provider:
			"First, choose your AI provider. You can pick from Gemini, Claude, Grok, and more.",
		apikey:
			"Enter the API key for your chosen provider. The key is stored securely on your local machine only.",
		"agent-name": 'Give your AI agent a name. Here, we\'ll set it to "Naia".',
		"user-name": "Enter your name. Naia will address you by this name.",
		character: "Choose Naia's 3D avatar. You can also add your own VRM models.",
		personality:
			"Pick Naia's personality. Options include friendly, professional, and many more.",
		messenger:
			"You can set up messenger integration. This can also be changed later in settings.",
		complete: "Setup is complete! Shall we start chatting with Naia?",
		"chat-hello": 'Let\'s say hello: "Hi, Naia!"',
		"chat-response":
			"Naia greets you warmly. Responses appear in real time via streaming.",
		"chat-weather":
			"Now let's ask about the weather. Naia uses skills to fetch live information.",
		"chat-tool-result":
			"You can see tool execution results as cards. Click to expand the details.",
		"chat-time":
			"Let's try the time skill too. You can freely use a variety of built-in skills.",
		"history-tab":
			"In the History tab, you can review previous chat sessions and continue any conversation.",
		"skills-list":
			"This is the Skills tab. Weather, time, notes, file management — many skills are installed.",
		"skills-detail": "Expand a skill card to see its description and settings.",
		"channels-tab":
			"The Channels tab lets you manage messenger integrations like Discord.",
		"agents-tab":
			"The Agents tab lets you monitor running agents and sessions.",
		"diagnostics-tab":
			"The Diagnostics tab gives you an overview of gateway, agent, and system status.",
		"settings-ai":
			"This is the Settings tab. Change your AI provider, model, or API key anytime.",
		"settings-voice":
			"In voice settings, customize the TTS voice and conversation language.",
		"settings-memory":
			"In memory settings, manage the facts Naia remembers about you.",
		"progress-tab":
			"The Progress tab shows AI usage, costs, and tool execution statistics.",
		outro: "Naia OS — your personal AI partner. Thank you for watching.",
	},

	ja: {
		intro:
			"Naia OSへようこそ。AIアバターと共に暮らすパーソナルOS、セットアップを始めましょう。",
		provider:
			"まず、AIプロバイダーを選択します。Gemini、Claude、Grokなどから選べます。",
		apikey:
			"選択したプロバイダーのAPIキーを入力します。キーはローカルにのみ安全に保存されます。",
		"agent-name":
			"AIエージェントの名前を決めます。ここでは「ナイア」に設定します。",
		"user-name": "ユーザー名を入力します。ナイアがこの名前で呼んでくれます。",
		character:
			"ナイアの3Dアバターを選びます。VRMモデルを自分で追加することもできます。",
		personality:
			"ナイアの性格を選びます。フレンドリー、プロフェッショナルなど、さまざまなオプションがあります。",
		messenger:
			"メッセンジャー連携を設定できます。後から設定で変更することも可能です。",
		complete: "セットアップが完了しました！ナイアとチャットを始めましょう。",
		"chat-hello": "「こんにちは、ナイア！」と挨拶してみましょう。",
		"chat-response":
			"ナイアが温かく挨拶を返してくれます。リアルタイムストリーミングで応答が表示されます。",
		"chat-weather":
			"次は天気を聞いてみましょう。ナイアはスキルを使ってリアルタイム情報を取得します。",
		"chat-tool-result":
			"ツール実行結果はカードで確認できます。クリックすると詳細が展開されます。",
		"chat-time":
			"時間スキルも使ってみましょう。さまざまな内蔵スキルを自由に活用できます。",
		"history-tab":
			"履歴タブでは、過去のチャットセッションを確認し、会話を続けることができます。",
		"skills-list":
			"スキルタブです。天気、時間、メモ、ファイル管理など、多くのスキルがインストールされています。",
		"skills-detail": "スキルカードを展開すると、詳細説明と設定を確認できます。",
		"channels-tab":
			"チャンネルタブでは、Discordなどのメッセンジャー連携状態を管理します。",
		"agents-tab":
			"エージェントタブでは、実行中のエージェントとセッションをモニタリングします。",
		"diagnostics-tab":
			"診断タブでは、ゲートウェイ、エージェント、システムの状態を一覧で確認できます。",
		"settings-ai":
			"設定タブです。AIプロバイダー、モデル、APIキーはいつでも変更できます。",
		"settings-voice": "音声設定では、TTS音声と会話言語をカスタマイズします。",
		"settings-memory": "記憶設定では、ナイアが覚えている事実を管理できます。",
		"progress-tab":
			"進捗タブでは、AI使用量、コスト、ツール実行統計を確認します。",
		outro:
			"Naia OS、あなただけのAIパートナーと一緒に。ご覧いただきありがとうございました。",
	},

	zh: {
		intro:
			"欢迎来到Naia OS。这是一个与AI虚拟形象共同生活的个人操作系统，让我们开始设置吧。",
		provider: "首先，选择您的AI提供商。您可以从Gemini、Claude、Grok等中选择。",
		apikey: "输入所选提供商的API密钥。密钥仅安全存储在本地设备上。",
		"agent-name":
			"为您的AI助手取一个名字。这里我们将其设置为\u201CNaia\u201D。",
		"user-name": "输入您的名字。Naia会用这个名字称呼您。",
		character: "选择Naia的3D虚拟形象。您也可以添加自己的VRM模型。",
		personality: "选择Naia的性格。有亲切型、专业型等多种选项。",
		messenger: "您可以设置即时通讯集成。之后也可以在设置中更改。",
		complete: "设置完成！让我们开始和Naia聊天吧。",
		"chat-hello": "让我们打个招呼：\u201C你好，Naia！\u201D",
		"chat-response": "Naia热情地回应问候。通过实时流式传输显示回复。",
		"chat-weather": "接下来问问天气。Naia使用技能获取实时信息。",
		"chat-tool-result": "工具执行结果以卡片形式展示。点击可展开查看详情。",
		"chat-time": "再试试时间技能。您可以自由使用各种内置技能。",
		"history-tab": "在历史记录选项卡中，您可以查看之前的聊天会话并继续对话。",
		"skills-list":
			"这是技能选项卡。天气、时间、笔记、文件管理等多种技能已安装就绪。",
		"skills-detail": "展开技能卡片可以查看详细说明和设置。",
		"channels-tab": "频道选项卡用于管理Discord等即时通讯的集成状态。",
		"agents-tab": "代理选项卡用于监控正在运行的代理和会话。",
		"diagnostics-tab": "诊断选项卡可以一目了然地查看网关、代理和系统状态。",
		"settings-ai": "这是设置选项卡。您可以随时更改AI提供商、模型和API密钥。",
		"settings-voice": "在语音设置中，自定义TTS语音和对话语言。",
		"settings-memory": "在记忆设置中，管理Naia记住的关于您的信息。",
		"progress-tab": "进度选项卡显示AI使用量、费用和工具执行统计。",
		outro: "Naia OS，与您专属的AI伙伴同行。感谢观看。",
	},

	fr: {
		intro:
			"Bienvenue sur Naia OS. Un système d'exploitation personnel avec votre propre avatar IA. Commençons la configuration.",
		provider:
			"Tout d'abord, choisissez votre fournisseur d'IA. Vous pouvez choisir parmi Gemini, Claude, Grok et d'autres.",
		apikey:
			"Entrez la clé API de votre fournisseur choisi. La clé est stockée en toute sécurité uniquement sur votre machine locale.",
		"agent-name":
			"Donnez un nom à votre agent IA. Ici, nous l'appellerons « Naia ».",
		"user-name": "Entrez votre nom. Naia vous appellera par ce nom.",
		character:
			"Choisissez l'avatar 3D de Naia. Vous pouvez aussi ajouter vos propres modèles VRM.",
		personality:
			"Choisissez la personnalité de Naia. Les options incluent amical, professionnel, et bien d'autres.",
		messenger:
			"Vous pouvez configurer l'intégration de messagerie. Cela peut aussi être modifié plus tard dans les paramètres.",
		complete:
			"La configuration est terminée ! On commence à discuter avec Naia ?",
		"chat-hello": "Disons bonjour : « Salut, Naia ! »",
		"chat-response":
			"Naia vous salue chaleureusement. Les réponses apparaissent en temps réel via le streaming.",
		"chat-weather":
			"Demandons maintenant la météo. Naia utilise ses compétences pour récupérer des informations en direct.",
		"chat-tool-result":
			"Les résultats d'exécution des outils s'affichent sous forme de cartes. Cliquez pour voir les détails.",
		"chat-time":
			"Essayons aussi la compétence heure. Vous pouvez librement utiliser diverses compétences intégrées.",
		"history-tab":
			"L'onglet Historique permet de consulter les sessions de chat précédentes et de reprendre une conversation.",
		"skills-list":
			"Voici l'onglet Compétences. Météo, heure, notes, gestion de fichiers — de nombreuses compétences sont installées.",
		"skills-detail":
			"Développez une carte de compétence pour voir sa description et ses paramètres.",
		"channels-tab":
			"L'onglet Canaux permet de gérer les intégrations de messagerie comme Discord.",
		"agents-tab":
			"L'onglet Agents permet de surveiller les agents en cours d'exécution et les sessions.",
		"diagnostics-tab":
			"L'onglet Diagnostics donne un aperçu de l'état de la passerelle, des agents et du système.",
		"settings-ai":
			"Voici l'onglet Paramètres. Changez votre fournisseur IA, modèle ou clé API à tout moment.",
		"settings-voice":
			"Dans les paramètres vocaux, personnalisez la voix TTS et la langue de conversation.",
		"settings-memory":
			"Dans les paramètres de mémoire, gérez les informations que Naia retient sur vous.",
		"progress-tab":
			"L'onglet Progression affiche l'utilisation de l'IA, les coûts et les statistiques d'exécution des outils.",
		outro: "Naia OS — votre partenaire IA personnel. Merci d'avoir regardé.",
	},

	de: {
		intro:
			"Willkommen bei Naia OS. Ein persönliches Betriebssystem mit Ihrem eigenen KI-Avatar. Beginnen wir mit der Einrichtung.",
		provider:
			"Wählen Sie zunächst Ihren KI-Anbieter. Sie können aus Gemini, Claude, Grok und weiteren wählen.",
		apikey:
			"Geben Sie den API-Schlüssel Ihres gewählten Anbieters ein. Der Schlüssel wird nur lokal sicher gespeichert.",
		"agent-name":
			"Geben Sie Ihrem KI-Agenten einen Namen. Hier setzen wir ihn auf \u201ENaia\u201C.",
		"user-name":
			"Geben Sie Ihren Namen ein. Naia wird Sie mit diesem Namen ansprechen.",
		character:
			"Wählen Sie Naias 3D-Avatar. Sie können auch eigene VRM-Modelle hinzufügen.",
		personality:
			"Wählen Sie Naias Persönlichkeit. Optionen sind unter anderem freundlich, professionell und viele mehr.",
		messenger:
			"Sie können die Messenger-Integration einrichten. Dies kann auch später in den Einstellungen geändert werden.",
		complete: "Die Einrichtung ist abgeschlossen! Sollen wir mit Naia chatten?",
		"chat-hello": "Sagen wir Hallo: \u201EHi, Naia!\u201C",
		"chat-response":
			"Naia begrüßt Sie herzlich. Antworten erscheinen in Echtzeit per Streaming.",
		"chat-weather":
			"Fragen wir nach dem Wetter. Naia nutzt Skills, um Echtzeitinformationen abzurufen.",
		"chat-tool-result":
			"Tool-Ergebnisse werden als Karten angezeigt. Klicken Sie, um Details zu sehen.",
		"chat-time":
			"Probieren wir auch den Zeit-Skill aus. Sie können verschiedene integrierte Skills frei nutzen.",
		"history-tab":
			"Im Verlauf-Tab können Sie frühere Chat-Sitzungen einsehen und Gespräche fortsetzen.",
		"skills-list":
			"Dies ist der Skills-Tab. Wetter, Zeit, Notizen, Dateiverwaltung — viele Skills sind installiert.",
		"skills-detail":
			"Klappen Sie eine Skill-Karte auf, um Beschreibung und Einstellungen zu sehen.",
		"channels-tab":
			"Im Kanäle-Tab verwalten Sie Messenger-Integrationen wie Discord.",
		"agents-tab":
			"Im Agenten-Tab überwachen Sie laufende Agenten und Sitzungen.",
		"diagnostics-tab":
			"Der Diagnose-Tab gibt einen Überblick über Gateway-, Agenten- und Systemstatus.",
		"settings-ai":
			"Dies ist der Einstellungen-Tab. Ändern Sie Ihren KI-Anbieter, Modell oder API-Schlüssel jederzeit.",
		"settings-voice":
			"In den Spracheinstellungen passen Sie die TTS-Stimme und Gesprächssprache an.",
		"settings-memory":
			"In den Gedächtnis-Einstellungen verwalten Sie die Fakten, die Naia über Sie speichert.",
		"progress-tab":
			"Der Fortschritt-Tab zeigt KI-Nutzung, Kosten und Tool-Ausführungsstatistiken.",
		outro: "Naia OS — Ihr persönlicher KI-Partner. Vielen Dank fürs Zuschauen.",
	},

	ru: {
		intro:
			"Добро пожаловать в Naia OS. Персональная операционная система с вашим собственным ИИ-аватаром. Начнём настройку.",
		provider:
			"Сначала выберите поставщика ИИ. Доступны Gemini, Claude, Grok и другие.",
		apikey:
			"Введите API-ключ выбранного поставщика. Ключ надёжно хранится только на вашем устройстве.",
		"agent-name": "Дайте имя вашему ИИ-агенту. Здесь мы назовём его «Naia».",
		"user-name":
			"Введите ваше имя. Naia будет обращаться к вам по этому имени.",
		character:
			"Выберите 3D-аватар Naia. Вы также можете добавить собственные VRM-модели.",
		personality:
			"Выберите характер Naia. Варианты: дружелюбный, профессиональный и многие другие.",
		messenger:
			"Можно настроить интеграцию с мессенджером. Это можно изменить позже в настройках.",
		complete: "Настройка завершена! Начнём общение с Naia?",
		"chat-hello": "Поздороваемся: «Привет, Naia!»",
		"chat-response":
			"Naia приветствует вас. Ответы отображаются в реальном времени через потоковую передачу.",
		"chat-weather":
			"Теперь спросим о погоде. Naia использует навыки для получения актуальной информации.",
		"chat-tool-result":
			"Результаты выполнения инструментов отображаются в виде карточек. Нажмите, чтобы раскрыть подробности.",
		"chat-time":
			"Попробуем навык времени. Вы можете свободно использовать различные встроенные навыки.",
		"history-tab":
			"На вкладке «История» можно просмотреть предыдущие сеансы чата и продолжить беседу.",
		"skills-list":
			"Это вкладка «Навыки». Погода, время, заметки, управление файлами — установлено множество навыков.",
		"skills-detail":
			"Раскройте карточку навыка, чтобы увидеть описание и настройки.",
		"channels-tab":
			"На вкладке «Каналы» управляйте интеграциями с мессенджерами, такими как Discord.",
		"agents-tab":
			"На вкладке «Агенты» отслеживайте работающих агентов и сеансы.",
		"diagnostics-tab":
			"Вкладка «Диагностика» показывает состояние шлюза, агентов и системы.",
		"settings-ai":
			"Это вкладка «Настройки». Смените поставщика ИИ, модель или API-ключ в любое время.",
		"settings-voice": "В настройках голоса настройте голос TTS и язык общения.",
		"settings-memory":
			"В настройках памяти управляйте фактами, которые Naia помнит о вас.",
		"progress-tab":
			"Вкладка «Прогресс» показывает использование ИИ, затраты и статистику выполнения инструментов.",
		outro: "Naia OS — ваш персональный ИИ-партнёр. Спасибо за просмотр.",
	},

	es: {
		intro:
			"Bienvenido a Naia OS. Un sistema operativo personal con tu propio avatar de IA. Comencemos con la configuración.",
		provider:
			"Primero, elige tu proveedor de IA. Puedes elegir entre Gemini, Claude, Grok y más.",
		apikey:
			"Introduce la clave API de tu proveedor elegido. La clave se almacena de forma segura solo en tu dispositivo local.",
		"agent-name":
			"Dale un nombre a tu agente de IA. Aquí lo llamaremos «Naia».",
		"user-name": "Introduce tu nombre. Naia te llamará por este nombre.",
		character:
			"Elige el avatar 3D de Naia. También puedes añadir tus propios modelos VRM.",
		personality:
			"Elige la personalidad de Naia. Las opciones incluyen amigable, profesional y muchas más.",
		messenger:
			"Puedes configurar la integración de mensajería. También se puede cambiar más tarde en ajustes.",
		complete: "¡La configuración está completa! ¿Empezamos a chatear con Naia?",
		"chat-hello": "Saludemos: «¡Hola, Naia!»",
		"chat-response":
			"Naia te saluda calurosamente. Las respuestas aparecen en tiempo real mediante streaming.",
		"chat-weather":
			"Ahora preguntemos por el clima. Naia usa habilidades para obtener información en tiempo real.",
		"chat-tool-result":
			"Los resultados de ejecución de herramientas se muestran como tarjetas. Haz clic para ver los detalles.",
		"chat-time":
			"Probemos también la habilidad de hora. Puedes usar libremente diversas habilidades integradas.",
		"history-tab":
			"En la pestaña Historial puedes revisar sesiones de chat anteriores y continuar cualquier conversación.",
		"skills-list":
			"Esta es la pestaña de Habilidades. Clima, hora, notas, gestión de archivos — muchas habilidades instaladas.",
		"skills-detail":
			"Expande una tarjeta de habilidad para ver su descripción y configuración.",
		"channels-tab":
			"La pestaña Canales permite gestionar integraciones de mensajería como Discord.",
		"agents-tab":
			"La pestaña Agentes permite monitorizar los agentes en ejecución y las sesiones.",
		"diagnostics-tab":
			"La pestaña Diagnósticos ofrece una visión general del estado del gateway, agentes y sistema.",
		"settings-ai":
			"Esta es la pestaña de Ajustes. Cambia tu proveedor de IA, modelo o clave API en cualquier momento.",
		"settings-voice":
			"En los ajustes de voz, personaliza la voz TTS y el idioma de conversación.",
		"settings-memory":
			"En los ajustes de memoria, gestiona los datos que Naia recuerda sobre ti.",
		"progress-tab":
			"La pestaña Progreso muestra el uso de IA, costes y estadísticas de ejecución de herramientas.",
		outro: "Naia OS — tu compañero de IA personal. Gracias por ver.",
	},

	ar: {
		intro:
			"مرحباً بكم في Naia OS. نظام تشغيل شخصي مع صورة رمزية ذكاء اصطناعي خاصة بك. لنبدأ الإعداد.",
		provider:
			"أولاً، اختر مزود الذكاء الاصطناعي. يمكنك الاختيار من Gemini وClaude وGrok والمزيد.",
		apikey:
			"أدخل مفتاح API للمزود الذي اخترته. يُخزَّن المفتاح بأمان على جهازك المحلي فقط.",
		"agent-name":
			'أعطِ اسماً لوكيل الذكاء الاصطناعي الخاص بك. هنا سنسميه "نايا".',
		"user-name": "أدخل اسمك. ستناديك نايا بهذا الاسم.",
		character:
			"اختر الصورة الرمزية ثلاثية الأبعاد لنايا. يمكنك أيضاً إضافة نماذج VRM خاصة بك.",
		personality:
			"اختر شخصية نايا. تتضمن الخيارات الودي والمحترف وغيرها الكثير.",
		messenger: "يمكنك إعداد تكامل المراسلة. يمكن تغيير هذا لاحقاً في الإعدادات.",
		complete: "اكتمل الإعداد! هل نبدأ الدردشة مع نايا؟",
		"chat-hello": 'لنقل مرحباً: "أهلاً، نايا!"',
		"chat-response":
			"نايا تحييك بحرارة. تظهر الردود في الوقت الفعلي عبر البث المباشر.",
		"chat-weather":
			"لنسأل عن الطقس الآن. تستخدم نايا المهارات لجلب المعلومات الحية.",
		"chat-tool-result":
			"يمكنك رؤية نتائج تنفيذ الأدوات كبطاقات. انقر لتوسيع التفاصيل.",
		"chat-time":
			"لنجرب مهارة الوقت أيضاً. يمكنك استخدام مجموعة متنوعة من المهارات المدمجة بحرية.",
		"history-tab":
			"في علامة تبويب السجل، يمكنك مراجعة جلسات الدردشة السابقة ومتابعة أي محادثة.",
		"skills-list":
			"هذه علامة تبويب المهارات. الطقس، الوقت، الملاحظات، إدارة الملفات — العديد من المهارات مثبتة.",
		"skills-detail": "وسّع بطاقة المهارة لرؤية وصفها وإعداداتها.",
		"channels-tab":
			"تتيح لك علامة تبويب القنوات إدارة تكاملات المراسلة مثل Discord.",
		"agents-tab":
			"تتيح لك علامة تبويب الوكلاء مراقبة الوكلاء قيد التشغيل والجلسات.",
		"diagnostics-tab":
			"توفر علامة تبويب التشخيص نظرة شاملة على حالة البوابة والوكلاء والنظام.",
		"settings-ai":
			"هذه علامة تبويب الإعدادات. غيّر مزود الذكاء الاصطناعي أو النموذج أو مفتاح API في أي وقت.",
		"settings-voice": "في إعدادات الصوت، خصّص صوت TTS ولغة المحادثة.",
		"settings-memory":
			"في إعدادات الذاكرة، أدِر المعلومات التي تتذكرها نايا عنك.",
		"progress-tab":
			"تعرض علامة تبويب التقدم استخدام الذكاء الاصطناعي والتكاليف وإحصاءات تنفيذ الأدوات.",
		outro: "Naia OS — شريكك الشخصي في الذكاء الاصطناعي. شكراً للمشاهدة.",
	},

	hi: {
		intro:
			"Naia OS में आपका स्वागत है। अपने AI अवतार के साथ एक व्यक्तिगत ऑपरेटिंग सिस्टम। चलिए सेटअप शुरू करते हैं।",
		provider:
			"सबसे पहले, अपना AI प्रदाता चुनें। आप Gemini, Claude, Grok और अन्य में से चुन सकते हैं।",
		apikey:
			"अपने चुने हुए प्रदाता की API कुंजी दर्ज करें। कुंजी केवल आपके स्थानीय डिवाइस पर सुरक्षित रूप से संग्रहीत होती है।",
		"agent-name": 'अपने AI एजेंट को एक नाम दें। यहाँ हम इसे "नाइआ" नाम देंगे।',
		"user-name": "अपना नाम दर्ज करें। नाइआ आपको इस नाम से बुलाएगी।",
		character: "नाइआ का 3D अवतार चुनें। आप अपने VRM मॉडल भी जोड़ सकते हैं।",
		personality: "नाइआ का व्यक्तित्व चुनें। विकल्पों में मित्रवत, पेशेवर और कई अन्य शामिल हैं।",
		messenger:
			"आप मैसेंजर इंटीग्रेशन सेट कर सकते हैं। इसे बाद में सेटिंग्स में भी बदला जा सकता है।",
		complete: "सेटअप पूरा हो गया! क्या हम नाइआ से बात शुरू करें?",
		"chat-hello": 'चलिए नमस्ते कहते हैं: "हाय, नाइआ!"',
		"chat-response":
			"नाइआ गर्मजोशी से अभिवादन करती है। स्ट्रीमिंग के माध्यम से रीयल-टाइम में जवाब दिखाई देते हैं।",
		"chat-weather":
			"अब मौसम के बारे में पूछते हैं। नाइआ लाइव जानकारी लाने के लिए स्किल का उपयोग करती है।",
		"chat-tool-result":
			"टूल निष्पादन परिणाम कार्ड के रूप में दिखाई देते हैं। विवरण देखने के लिए क्लिक करें।",
		"chat-time":
			"समय स्किल भी आज़माते हैं। आप विभिन्न बिल्ट-इन स्किल्स का स्वतंत्र रूप से उपयोग कर सकते हैं।",
		"history-tab":
			"इतिहास टैब में, आप पिछली चैट सत्रों की समीक्षा कर सकते हैं और किसी भी बातचीत को जारी रख सकते हैं।",
		"skills-list":
			"यह स्किल्स टैब है। मौसम, समय, नोट्स, फ़ाइल प्रबंधन — कई स्किल्स इंस्टॉल हैं।",
		"skills-detail": "स्किल कार्ड को विस्तारित करके उसका विवरण और सेटिंग्स देखें।",
		"channels-tab": "चैनल टैब में Discord जैसे मैसेंजर इंटीग्रेशन प्रबंधित करें।",
		"agents-tab": "एजेंट टैब में चल रहे एजेंटों और सत्रों की निगरानी करें।",
		"diagnostics-tab":
			"डायग्नोस्टिक्स टैब गेटवे, एजेंट और सिस्टम स्थिति का अवलोकन देता है।",
		"settings-ai": "यह सेटिंग्स टैब है। कभी भी AI प्रदाता, मॉडल या API कुंजी बदलें।",
		"settings-voice": "वॉइस सेटिंग्स में TTS आवाज़ और बातचीत की भाषा कस्टमाइज़ करें।",
		"settings-memory":
			"मेमोरी सेटिंग्स में नाइआ आपके बारे में जो तथ्य याद रखती है उन्हें प्रबंधित करें।",
		"progress-tab": "प्रगति टैब AI उपयोग, लागत और टूल निष्पादन आँकड़े दिखाता है।",
		outro: "Naia OS — आपका व्यक्तिगत AI साथी। देखने के लिए धन्यवाद।",
	},

	bn: {
		intro:
			"Naia OS-এ স্বাগতম। আপনার নিজস্ব AI অবতারের সাথে একটি ব্যক্তিগত অপারেটিং সিস্টেম। চলুন সেটআপ শুরু করি।",
		provider:
			"প্রথমে, আপনার AI প্রদানকারী বেছে নিন। আপনি Gemini, Claude, Grok এবং আরও অনেক থেকে বেছে নিতে পারেন।",
		apikey:
			"আপনার নির্বাচিত প্রদানকারীর API কী লিখুন। কীটি শুধুমাত্র আপনার স্থানীয় ডিভাইসে নিরাপদে সংরক্ষিত হয়।",
		"agent-name": 'আপনার AI এজেন্টকে একটি নাম দিন। এখানে আমরা এটিকে "নাইয়া" নাম দেব।',
		"user-name": "আপনার নাম লিখুন। নাইয়া আপনাকে এই নামে ডাকবে।",
		character: "নাইয়ার 3D অবতার বেছে নিন। আপনি নিজের VRM মডেলও যোগ করতে পারেন।",
		personality:
			"নাইয়ার ব্যক্তিত্ব বেছে নিন। বন্ধুত্বপূর্ণ, পেশাদার এবং আরও অনেক বিকল্প আছে।",
		messenger:
			"আপনি মেসেঞ্জার ইন্টিগ্রেশন সেট আপ করতে পারেন। এটি পরে সেটিংসেও পরিবর্তন করা যায়।",
		complete: "সেটআপ সম্পন্ন! চলুন নাইয়ার সাথে চ্যাট শুরু করি।",
		"chat-hello": 'চলুন হ্যালো বলি: "হাই, নাইয়া!"',
		"chat-response":
			"নাইয়া আন্তরিকভাবে অভিবাদন জানায়। স্ট্রিমিংয়ের মাধ্যমে রিয়েল-টাইমে উত্তর দেখা যায়।",
		"chat-weather": "এবার আবহাওয়া জিজ্ঞেস করি। নাইয়া লাইভ তথ্য আনতে স্কিল ব্যবহার করে।",
		"chat-tool-result":
			"টুল এক্সিকিউশন ফলাফল কার্ড হিসেবে দেখা যায়। বিস্তারিত দেখতে ক্লিক করুন।",
		"chat-time":
			"সময় স্কিলও চেষ্টা করি। আপনি বিভিন্ন বিল্ট-ইন স্কিল স্বাধীনভাবে ব্যবহার করতে পারেন।",
		"history-tab":
			"ইতিহাস ট্যাবে, আপনি আগের চ্যাট সেশন পর্যালোচনা করতে এবং যেকোনো কথোপকথন চালিয়ে যেতে পারেন।",
		"skills-list":
			"এটি স্কিলস ট্যাব। আবহাওয়া, সময়, নোট, ফাইল ম্যানেজমেন্ট — অনেক স্কিল ইনস্টল আছে।",
		"skills-detail": "স্কিল কার্ড প্রসারিত করে এর বিবরণ এবং সেটিংস দেখুন।",
		"channels-tab": "চ্যানেল ট্যাবে Discord এর মতো মেসেঞ্জার ইন্টিগ্রেশন পরিচালনা করুন।",
		"agents-tab": "এজেন্ট ট্যাবে চলমান এজেন্ট এবং সেশন মনিটর করুন।",
		"diagnostics-tab":
			"ডায়াগনস্টিকস ট্যাব গেটওয়ে, এজেন্ট এবং সিস্টেম স্ট্যাটাস এক নজরে দেখায়।",
		"settings-ai":
			"এটি সেটিংস ট্যাব। যেকোনো সময় AI প্রদানকারী, মডেল বা API কী পরিবর্তন করুন।",
		"settings-voice": "ভয়েস সেটিংসে TTS ভয়েস এবং কথোপকথনের ভাষা কাস্টমাইজ করুন।",
		"settings-memory":
			"মেমোরি সেটিংসে নাইয়া আপনার সম্পর্কে যে তথ্য মনে রাখে সেগুলো পরিচালনা করুন।",
		"progress-tab": "প্রগ্রেস ট্যাব AI ব্যবহার, খরচ এবং টুল এক্সিকিউশন পরিসংখ্যান দেখায়।",
		outro: "Naia OS — আপনার ব্যক্তিগত AI সঙ্গী। দেখার জন্য ধন্যবাদ।",
	},

	pt: {
		intro:
			"Bem-vindo ao Naia OS. Um sistema operacional pessoal com seu próprio avatar de IA. Vamos começar a configuração.",
		provider:
			"Primeiro, escolha seu provedor de IA. Você pode escolher entre Gemini, Claude, Grok e mais.",
		apikey:
			"Digite a chave API do provedor escolhido. A chave é armazenada com segurança apenas no seu dispositivo local.",
		"agent-name":
			'Dê um nome ao seu agente de IA. Aqui, vamos chamá-lo de "Naia".',
		"user-name": "Digite seu nome. Naia vai te chamar por esse nome.",
		character:
			"Escolha o avatar 3D da Naia. Você também pode adicionar seus próprios modelos VRM.",
		personality:
			"Escolha a personalidade da Naia. As opções incluem amigável, profissional e muitas outras.",
		messenger:
			"Você pode configurar a integração com mensageiros. Isso também pode ser alterado depois nas configurações.",
		complete: "Configuração concluída! Vamos começar a conversar com a Naia?",
		"chat-hello": 'Vamos dizer olá: "Oi, Naia!"',
		"chat-response":
			"Naia te cumprimenta calorosamente. As respostas aparecem em tempo real via streaming.",
		"chat-weather":
			"Agora vamos perguntar sobre o clima. Naia usa habilidades para buscar informações em tempo real.",
		"chat-tool-result":
			"Os resultados de execução das ferramentas aparecem como cartões. Clique para expandir os detalhes.",
		"chat-time":
			"Vamos experimentar a habilidade de hora também. Você pode usar livremente diversas habilidades integradas.",
		"history-tab":
			"Na aba Histórico, você pode revisar sessões de chat anteriores e continuar qualquer conversa.",
		"skills-list":
			"Esta é a aba de Habilidades. Clima, hora, notas, gerenciamento de arquivos — muitas habilidades instaladas.",
		"skills-detail":
			"Expanda um cartão de habilidade para ver sua descrição e configurações.",
		"channels-tab":
			"A aba Canais permite gerenciar integrações de mensageiros como o Discord.",
		"agents-tab":
			"A aba Agentes permite monitorar agentes em execução e sessões.",
		"diagnostics-tab":
			"A aba Diagnósticos oferece uma visão geral do status do gateway, agentes e sistema.",
		"settings-ai":
			"Esta é a aba de Configurações. Altere seu provedor de IA, modelo ou chave API a qualquer momento.",
		"settings-voice":
			"Nas configurações de voz, personalize a voz TTS e o idioma da conversa.",
		"settings-memory":
			"Nas configurações de memória, gerencie os fatos que a Naia lembra sobre você.",
		"progress-tab":
			"A aba Progresso mostra o uso de IA, custos e estatísticas de execução de ferramentas.",
		outro: "Naia OS — seu parceiro de IA pessoal. Obrigado por assistir.",
	},

	id: {
		intro:
			"Selamat datang di Naia OS. Sistem operasi pribadi dengan avatar AI Anda sendiri. Mari mulai pengaturan.",
		provider:
			"Pertama, pilih penyedia AI Anda. Anda dapat memilih dari Gemini, Claude, Grok, dan lainnya.",
		apikey:
			"Masukkan kunci API penyedia yang dipilih. Kunci disimpan dengan aman hanya di perangkat lokal Anda.",
		"agent-name":
			'Beri nama agen AI Anda. Di sini, kita akan menamainya "Naia".',
		"user-name":
			"Masukkan nama Anda. Naia akan memanggil Anda dengan nama ini.",
		character:
			"Pilih avatar 3D Naia. Anda juga dapat menambahkan model VRM Anda sendiri.",
		personality:
			"Pilih kepribadian Naia. Pilihan termasuk ramah, profesional, dan banyak lagi.",
		messenger:
			"Anda dapat mengatur integrasi messenger. Ini juga bisa diubah nanti di pengaturan.",
		complete: "Pengaturan selesai! Mari mulai mengobrol dengan Naia.",
		"chat-hello": 'Mari kita menyapa: "Hai, Naia!"',
		"chat-response":
			"Naia menyapa Anda dengan hangat. Respons muncul secara real-time melalui streaming.",
		"chat-weather":
			"Sekarang mari tanya tentang cuaca. Naia menggunakan skill untuk mengambil informasi langsung.",
		"chat-tool-result":
			"Hasil eksekusi alat ditampilkan sebagai kartu. Klik untuk melihat detail.",
		"chat-time":
			"Mari coba skill waktu juga. Anda dapat dengan bebas menggunakan berbagai skill bawaan.",
		"history-tab":
			"Di tab Riwayat, Anda dapat meninjau sesi obrolan sebelumnya dan melanjutkan percakapan apa pun.",
		"skills-list":
			"Ini adalah tab Skills. Cuaca, waktu, catatan, manajemen file — banyak skill telah terpasang.",
		"skills-detail":
			"Perluas kartu skill untuk melihat deskripsi dan pengaturannya.",
		"channels-tab":
			"Tab Saluran memungkinkan Anda mengelola integrasi messenger seperti Discord.",
		"agents-tab":
			"Tab Agen memungkinkan Anda memantau agen yang berjalan dan sesi.",
		"diagnostics-tab":
			"Tab Diagnostik memberikan gambaran status gateway, agen, dan sistem.",
		"settings-ai":
			"Ini adalah tab Pengaturan. Ubah penyedia AI, model, atau kunci API kapan saja.",
		"settings-voice":
			"Di pengaturan suara, sesuaikan suara TTS dan bahasa percakapan.",
		"settings-memory":
			"Di pengaturan memori, kelola fakta yang Naia ingat tentang Anda.",
		"progress-tab":
			"Tab Progres menampilkan penggunaan AI, biaya, dan statistik eksekusi alat.",
		outro: "Naia OS — mitra AI pribadi Anda. Terima kasih telah menonton.",
	},

	vi: {
		intro:
			"Chào mừng bạn đến với Naia OS. Hệ điều hành cá nhân với avatar AI của riêng bạn. Hãy bắt đầu thiết lập.",
		provider:
			"Trước tiên, hãy chọn nhà cung cấp AI. Bạn có thể chọn Gemini, Claude, Grok và nhiều hơn nữa.",
		apikey:
			"Nhập khóa API của nhà cung cấp đã chọn. Khóa được lưu trữ an toàn chỉ trên thiết bị của bạn.",
		"agent-name":
			'Đặt tên cho trợ lý AI của bạn. Ở đây, chúng ta sẽ đặt tên là "Naia".',
		"user-name": "Nhập tên của bạn. Naia sẽ gọi bạn bằng tên này.",
		character:
			"Chọn hình đại diện 3D của Naia. Bạn cũng có thể thêm mô hình VRM của riêng mình.",
		personality:
			"Chọn tính cách của Naia. Các tùy chọn bao gồm thân thiện, chuyên nghiệp và nhiều hơn nữa.",
		messenger:
			"Bạn có thể thiết lập tích hợp ứng dụng nhắn tin. Điều này cũng có thể thay đổi sau trong cài đặt.",
		complete: "Thiết lập hoàn tất! Hãy bắt đầu trò chuyện với Naia nào.",
		"chat-hello": 'Hãy chào hỏi: "Xin chào, Naia!"',
		"chat-response":
			"Naia chào bạn nồng nhiệt. Phản hồi xuất hiện theo thời gian thực qua streaming.",
		"chat-weather":
			"Bây giờ hãy hỏi về thời tiết. Naia sử dụng kỹ năng để lấy thông tin trực tiếp.",
		"chat-tool-result":
			"Kết quả thực thi công cụ hiển thị dưới dạng thẻ. Nhấn để xem chi tiết.",
		"chat-time":
			"Hãy thử kỹ năng thời gian nữa. Bạn có thể tự do sử dụng nhiều kỹ năng tích hợp khác nhau.",
		"history-tab":
			"Trong tab Lịch sử, bạn có thể xem lại các phiên trò chuyện trước và tiếp tục bất kỳ cuộc hội thoại nào.",
		"skills-list":
			"Đây là tab Kỹ năng. Thời tiết, thời gian, ghi chú, quản lý tệp — nhiều kỹ năng đã được cài đặt.",
		"skills-detail": "Mở rộng thẻ kỹ năng để xem mô tả và cài đặt của nó.",
		"channels-tab":
			"Tab Kênh cho phép bạn quản lý tích hợp ứng dụng nhắn tin như Discord.",
		"agents-tab":
			"Tab Trợ lý cho phép bạn giám sát các trợ lý đang chạy và phiên làm việc.",
		"diagnostics-tab":
			"Tab Chẩn đoán cung cấp cái nhìn tổng quan về trạng thái gateway, trợ lý và hệ thống.",
		"settings-ai":
			"Đây là tab Cài đặt. Thay đổi nhà cung cấp AI, mô hình hoặc khóa API bất cứ lúc nào.",
		"settings-voice":
			"Trong cài đặt giọng nói, tùy chỉnh giọng TTS và ngôn ngữ hội thoại.",
		"settings-memory":
			"Trong cài đặt bộ nhớ, quản lý các thông tin Naia ghi nhớ về bạn.",
		"progress-tab":
			"Tab Tiến độ hiển thị mức sử dụng AI, chi phí và thống kê thực thi công cụ.",
		outro: "Naia OS — đối tác AI cá nhân của bạn. Cảm ơn bạn đã theo dõi.",
	},
};

/** UI input texts used during demo recording (onboarding + chat) */
export const DEMO_INPUTS: Record<
	NarrationLang,
	{
		agentName: string;
		userName: string;
		chatHello: string;
		chatWeather: string;
		chatTime: string;
	}
> = {
	ko: {
		agentName: "나이아",
		userName: "루크",
		chatHello: "안녕, 나이아!",
		chatWeather: "서울 날씨 알려줘",
		chatTime: "지금 몇 시야?",
	},
	en: {
		agentName: "Naia",
		userName: "Luke",
		chatHello: "Hi, Naia!",
		chatWeather: "How's the weather in Seoul?",
		chatTime: "What time is it?",
	},
	ja: {
		agentName: "ナイア",
		userName: "ルーク",
		chatHello: "こんにちは、ナイア！",
		chatWeather: "ソウルの天気を教えて",
		chatTime: "今何時？",
	},
	zh: {
		agentName: "Naia",
		userName: "Luke",
		chatHello: "你好，Naia！",
		chatWeather: "首尔天气怎么样？",
		chatTime: "现在几点了？",
	},
	fr: {
		agentName: "Naia",
		userName: "Luke",
		chatHello: "Salut, Naia !",
		chatWeather: "Quel temps fait-il à Séoul ?",
		chatTime: "Quelle heure est-il ?",
	},
	de: {
		agentName: "Naia",
		userName: "Luke",
		chatHello: "Hi, Naia!",
		chatWeather: "Wie ist das Wetter in Seoul?",
		chatTime: "Wie spät ist es?",
	},
	ru: {
		agentName: "Naia",
		userName: "Люк",
		chatHello: "Привет, Naia!",
		chatWeather: "Какая погода в Сеуле?",
		chatTime: "Который сейчас час?",
	},
	es: {
		agentName: "Naia",
		userName: "Luke",
		chatHello: "¡Hola, Naia!",
		chatWeather: "¿Cómo está el clima en Seúl?",
		chatTime: "¿Qué hora es?",
	},
	ar: {
		agentName: "نايا",
		userName: "لوك",
		chatHello: "أهلاً، نايا!",
		chatWeather: "كيف الطقس في سيول؟",
		chatTime: "كم الساعة الآن؟",
	},
	hi: {
		agentName: "नाइआ",
		userName: "ल्यूक",
		chatHello: "हाय, नाइआ!",
		chatWeather: "सियोल में मौसम कैसा है?",
		chatTime: "अभी क्या समय है?",
	},
	bn: {
		agentName: "নাইয়া",
		userName: "লুক",
		chatHello: "হাই, নাইয়া!",
		chatWeather: "সিউলে আবহাওয়া কেমন?",
		chatTime: "এখন কটা বাজে?",
	},
	pt: {
		agentName: "Naia",
		userName: "Luke",
		chatHello: "Oi, Naia!",
		chatWeather: "Como está o tempo em Seul?",
		chatTime: "Que horas são?",
	},
	id: {
		agentName: "Naia",
		userName: "Luke",
		chatHello: "Hai, Naia!",
		chatWeather: "Bagaimana cuaca di Seoul?",
		chatTime: "Jam berapa sekarang?",
	},
	vi: {
		agentName: "Naia",
		userName: "Luke",
		chatHello: "Xin chào, Naia!",
		chatWeather: "Thời tiết ở Seoul thế nào?",
		chatTime: "Bây giờ là mấy giờ?",
	},
};

/** Mock AI responses per language for demo recording */
export const DEMO_MOCK_RESPONSES: Record<
	NarrationLang,
	{
		greeting: string;
		weather: string;
		time: string;
	}
> = {
	ko: {
		greeting: "안녕하세요! 반가워요 😊 무엇을 도와드릴까요?",
		weather: "서울의 현재 날씨입니다. 기온 3°C, 맑은 하늘이에요! 🌤️",
		time: "현재 시간은 2026년 2월 19일 수요일 오후 7시입니다.",
	},
	en: {
		greeting: "Hello! Nice to meet you 😊 How can I help?",
		weather: "Here's the current weather in Seoul: 3°C, clear skies! 🌤️",
		time: "The current time is Wednesday, February 19, 2026, 7:00 PM.",
	},
	ja: {
		greeting: "こんにちは！お会いできて嬉しいです 😊 何かお手伝いできますか？",
		weather: "ソウルの現在の天気です。気温3°C、晴天です！🌤️",
		time: "現在の時刻は2026年2月19日水曜日午後7時です。",
	},
	zh: {
		greeting: "你好！很高兴见到你 😊 有什么可以帮忙的吗？",
		weather: "首尔当前天气：3°C，晴天！🌤️",
		time: "当前时间是2026年2月19日星期三下午7点。",
	},
	fr: {
		greeting:
			"Bonjour ! Ravie de vous rencontrer 😊 Comment puis-je vous aider ?",
		weather: "Voici la météo actuelle à Séoul : 3°C, ciel dégagé ! 🌤️",
		time: "L'heure actuelle est mercredi 19 février 2026, 19h00.",
	},
	de: {
		greeting: "Hallo! Schön, Sie kennenzulernen 😊 Wie kann ich helfen?",
		weather: "Aktuelles Wetter in Seoul: 3°C, klarer Himmel! 🌤️",
		time: "Die aktuelle Uhrzeit ist Mittwoch, 19. Februar 2026, 19:00 Uhr.",
	},
	ru: {
		greeting: "Привет! Рада познакомиться 😊 Чем могу помочь?",
		weather: "Текущая погода в Сеуле: 3°C, ясное небо! 🌤️",
		time: "Текущее время: среда, 19 февраля 2026 г., 19:00.",
	},
	es: {
		greeting: "¡Hola! Encantada de conocerte 😊 ¿En qué puedo ayudarte?",
		weather: "El clima actual en Seúl: 3°C, cielos despejados! 🌤️",
		time: "La hora actual es miércoles 19 de febrero de 2026, 19:00.",
	},
	ar: {
		greeting: "مرحباً! سعيدة بلقائك 😊 كيف يمكنني مساعدتك؟",
		weather: "الطقس الحالي في سيول: 3 درجات مئوية، سماء صافية! 🌤️",
		time: "الوقت الحالي هو الأربعاء 19 فبراير 2026، الساعة 7:00 مساءً.",
	},
	hi: {
		greeting: "नमस्ते! आपसे मिलकर खुशी हुई 😊 मैं कैसे मदद कर सकती हूँ?",
		weather: "सियोल का मौसम: 3°C, साफ आसमान! 🌤️",
		time: "वर्तमान समय: बुधवार, 19 फरवरी 2026, शाम 7:00 बजे।",
	},
	bn: {
		greeting: "হ্যালো! আপনার সাথে দেখা হয়ে ভালো লাগলো 😊 কীভাবে সাহায্য করতে পারি?",
		weather: "সিউলের বর্তমান আবহাওয়া: ৩°C, পরিষ্কার আকাশ! 🌤️",
		time: "বর্তমান সময়: বুধবার, ১৯ ফেব্রুয়ারি ২০২৬, সন্ধ্যা ৭:০০।",
	},
	pt: {
		greeting: "Olá! Prazer em conhecê-lo 😊 Como posso ajudar?",
		weather: "Clima atual em Seul: 3°C, céu limpo! 🌤️",
		time: "A hora atual é quarta-feira, 19 de fevereiro de 2026, 19:00.",
	},
	id: {
		greeting: "Halo! Senang bertemu dengan Anda 😊 Ada yang bisa saya bantu?",
		weather: "Cuaca saat ini di Seoul: 3°C, langit cerah! 🌤️",
		time: "Waktu saat ini: Rabu, 19 Februari 2026, pukul 19:00.",
	},
	vi: {
		greeting: "Xin chào! Rất vui được gặp bạn 😊 Tôi có thể giúp gì?",
		weather: "Thời tiết hiện tại ở Seoul: 3°C, trời quang! 🌤️",
		time: "Thời gian hiện tại: Thứ Tư, ngày 19 tháng 2 năm 2026, 19:00.",
	},
};

/** Mock UI data (sessions, facts, discord messages) per language for demo */
export const DEMO_MOCK_DATA: Record<
	NarrationLang,
	{
		sessions: Array<{
			id: string;
			title: string;
			created_at: string;
			updated_at: string;
			message_count: number;
		}>;
		facts: Array<{
			id: string;
			key: string;
			value: string;
			created_at: string;
		}>;
		discordMessages: Array<{
			id: string;
			content: string;
			author: { id: string; username: string; bot?: boolean };
			timestamp: string;
		}>;
		agentSession: {
			id: string;
			agentId: string;
			title: string;
			created_at: string;
			messageCount: number;
		};
	}
> = {
	ko: {
		sessions: [
			{
				id: "s1",
				title: "서울 날씨 확인",
				created_at: "2026-02-19T10:00:00Z",
				updated_at: "2026-02-19T10:05:00Z",
				message_count: 4,
			},
			{
				id: "s2",
				title: "프로젝트 파일 구조 분석",
				created_at: "2026-02-18T14:00:00Z",
				updated_at: "2026-02-18T14:30:00Z",
				message_count: 8,
			},
			{
				id: "s3",
				title: "코드 리뷰 요청",
				created_at: "2026-02-17T09:00:00Z",
				updated_at: "2026-02-17T09:20:00Z",
				message_count: 6,
			},
		],
		facts: [
			{
				id: "f1",
				key: "좋아하는 색",
				value: "파란색",
				created_at: "2026-02-19T10:00:00Z",
			},
			{
				id: "f2",
				key: "이름",
				value: "루크",
				created_at: "2026-02-18T09:00:00Z",
			},
			{
				id: "f3",
				key: "직업",
				value: "개발자",
				created_at: "2026-02-17T09:00:00Z",
			},
		],
		discordMessages: [
			{
				id: "m1",
				content: "안녕!",
				author: { id: "user-1", username: "루크" },
				timestamp: "2026-02-19T10:00:00Z",
			},
			{
				id: "m2",
				content: "안녕하세요! 무엇을 도와드릴까요?",
				author: { id: "bot-1", username: "Naia", bot: true },
				timestamp: "2026-02-19T10:00:01Z",
			},
		],
		agentSession: {
			id: "sess-1",
			agentId: "agent-1",
			title: "메인 세션",
			created_at: "2026-02-19T08:00:00Z",
			messageCount: 42,
		},
	},
	en: {
		sessions: [
			{
				id: "s1",
				title: "Check Seoul weather",
				created_at: "2026-02-19T10:00:00Z",
				updated_at: "2026-02-19T10:05:00Z",
				message_count: 4,
			},
			{
				id: "s2",
				title: "Analyze project structure",
				created_at: "2026-02-18T14:00:00Z",
				updated_at: "2026-02-18T14:30:00Z",
				message_count: 8,
			},
			{
				id: "s3",
				title: "Code review request",
				created_at: "2026-02-17T09:00:00Z",
				updated_at: "2026-02-17T09:20:00Z",
				message_count: 6,
			},
		],
		facts: [
			{
				id: "f1",
				key: "Favorite color",
				value: "Blue",
				created_at: "2026-02-19T10:00:00Z",
			},
			{
				id: "f2",
				key: "Name",
				value: "Luke",
				created_at: "2026-02-18T09:00:00Z",
			},
			{
				id: "f3",
				key: "Occupation",
				value: "Developer",
				created_at: "2026-02-17T09:00:00Z",
			},
		],
		discordMessages: [
			{
				id: "m1",
				content: "Hello!",
				author: { id: "user-1", username: "Luke" },
				timestamp: "2026-02-19T10:00:00Z",
			},
			{
				id: "m2",
				content: "Hi! How can I help you?",
				author: { id: "bot-1", username: "Naia", bot: true },
				timestamp: "2026-02-19T10:00:01Z",
			},
		],
		agentSession: {
			id: "sess-1",
			agentId: "agent-1",
			title: "Main session",
			created_at: "2026-02-19T08:00:00Z",
			messageCount: 42,
		},
	},
	ja: {
		sessions: [
			{
				id: "s1",
				title: "ソウルの天気確認",
				created_at: "2026-02-19T10:00:00Z",
				updated_at: "2026-02-19T10:05:00Z",
				message_count: 4,
			},
			{
				id: "s2",
				title: "プロジェクト構造分析",
				created_at: "2026-02-18T14:00:00Z",
				updated_at: "2026-02-18T14:30:00Z",
				message_count: 8,
			},
			{
				id: "s3",
				title: "コードレビュー依頼",
				created_at: "2026-02-17T09:00:00Z",
				updated_at: "2026-02-17T09:20:00Z",
				message_count: 6,
			},
		],
		facts: [
			{
				id: "f1",
				key: "好きな色",
				value: "青",
				created_at: "2026-02-19T10:00:00Z",
			},
			{
				id: "f2",
				key: "名前",
				value: "ルーク",
				created_at: "2026-02-18T09:00:00Z",
			},
			{
				id: "f3",
				key: "職業",
				value: "開発者",
				created_at: "2026-02-17T09:00:00Z",
			},
		],
		discordMessages: [
			{
				id: "m1",
				content: "こんにちは！",
				author: { id: "user-1", username: "ルーク" },
				timestamp: "2026-02-19T10:00:00Z",
			},
			{
				id: "m2",
				content: "こんにちは！何かお手伝いできますか？",
				author: { id: "bot-1", username: "Naia", bot: true },
				timestamp: "2026-02-19T10:00:01Z",
			},
		],
		agentSession: {
			id: "sess-1",
			agentId: "agent-1",
			title: "メインセッション",
			created_at: "2026-02-19T08:00:00Z",
			messageCount: 42,
		},
	},
	zh: {
		sessions: [
			{
				id: "s1",
				title: "查看首尔天气",
				created_at: "2026-02-19T10:00:00Z",
				updated_at: "2026-02-19T10:05:00Z",
				message_count: 4,
			},
			{
				id: "s2",
				title: "分析项目结构",
				created_at: "2026-02-18T14:00:00Z",
				updated_at: "2026-02-18T14:30:00Z",
				message_count: 8,
			},
			{
				id: "s3",
				title: "代码审查请求",
				created_at: "2026-02-17T09:00:00Z",
				updated_at: "2026-02-17T09:20:00Z",
				message_count: 6,
			},
		],
		facts: [
			{
				id: "f1",
				key: "喜欢的颜色",
				value: "蓝色",
				created_at: "2026-02-19T10:00:00Z",
			},
			{
				id: "f2",
				key: "姓名",
				value: "Luke",
				created_at: "2026-02-18T09:00:00Z",
			},
			{
				id: "f3",
				key: "职业",
				value: "开发者",
				created_at: "2026-02-17T09:00:00Z",
			},
		],
		discordMessages: [
			{
				id: "m1",
				content: "你好！",
				author: { id: "user-1", username: "Luke" },
				timestamp: "2026-02-19T10:00:00Z",
			},
			{
				id: "m2",
				content: "你好！有什么可以帮忙的吗？",
				author: { id: "bot-1", username: "Naia", bot: true },
				timestamp: "2026-02-19T10:00:01Z",
			},
		],
		agentSession: {
			id: "sess-1",
			agentId: "agent-1",
			title: "主会话",
			created_at: "2026-02-19T08:00:00Z",
			messageCount: 42,
		},
	},
	fr: {
		sessions: [
			{
				id: "s1",
				title: "Vérifier la météo à Séoul",
				created_at: "2026-02-19T10:00:00Z",
				updated_at: "2026-02-19T10:05:00Z",
				message_count: 4,
			},
			{
				id: "s2",
				title: "Analyser la structure du projet",
				created_at: "2026-02-18T14:00:00Z",
				updated_at: "2026-02-18T14:30:00Z",
				message_count: 8,
			},
			{
				id: "s3",
				title: "Demande de revue de code",
				created_at: "2026-02-17T09:00:00Z",
				updated_at: "2026-02-17T09:20:00Z",
				message_count: 6,
			},
		],
		facts: [
			{
				id: "f1",
				key: "Couleur préférée",
				value: "Bleu",
				created_at: "2026-02-19T10:00:00Z",
			},
			{
				id: "f2",
				key: "Nom",
				value: "Luke",
				created_at: "2026-02-18T09:00:00Z",
			},
			{
				id: "f3",
				key: "Métier",
				value: "Développeur",
				created_at: "2026-02-17T09:00:00Z",
			},
		],
		discordMessages: [
			{
				id: "m1",
				content: "Bonjour !",
				author: { id: "user-1", username: "Luke" },
				timestamp: "2026-02-19T10:00:00Z",
			},
			{
				id: "m2",
				content: "Bonjour ! Comment puis-je vous aider ?",
				author: { id: "bot-1", username: "Naia", bot: true },
				timestamp: "2026-02-19T10:00:01Z",
			},
		],
		agentSession: {
			id: "sess-1",
			agentId: "agent-1",
			title: "Session principale",
			created_at: "2026-02-19T08:00:00Z",
			messageCount: 42,
		},
	},
	de: {
		sessions: [
			{
				id: "s1",
				title: "Wetter in Seoul prüfen",
				created_at: "2026-02-19T10:00:00Z",
				updated_at: "2026-02-19T10:05:00Z",
				message_count: 4,
			},
			{
				id: "s2",
				title: "Projektstruktur analysieren",
				created_at: "2026-02-18T14:00:00Z",
				updated_at: "2026-02-18T14:30:00Z",
				message_count: 8,
			},
			{
				id: "s3",
				title: "Code-Review angefragt",
				created_at: "2026-02-17T09:00:00Z",
				updated_at: "2026-02-17T09:20:00Z",
				message_count: 6,
			},
		],
		facts: [
			{
				id: "f1",
				key: "Lieblingsfarbe",
				value: "Blau",
				created_at: "2026-02-19T10:00:00Z",
			},
			{
				id: "f2",
				key: "Name",
				value: "Luke",
				created_at: "2026-02-18T09:00:00Z",
			},
			{
				id: "f3",
				key: "Beruf",
				value: "Entwickler",
				created_at: "2026-02-17T09:00:00Z",
			},
		],
		discordMessages: [
			{
				id: "m1",
				content: "Hallo!",
				author: { id: "user-1", username: "Luke" },
				timestamp: "2026-02-19T10:00:00Z",
			},
			{
				id: "m2",
				content: "Hallo! Wie kann ich helfen?",
				author: { id: "bot-1", username: "Naia", bot: true },
				timestamp: "2026-02-19T10:00:01Z",
			},
		],
		agentSession: {
			id: "sess-1",
			agentId: "agent-1",
			title: "Hauptsitzung",
			created_at: "2026-02-19T08:00:00Z",
			messageCount: 42,
		},
	},
	ru: {
		sessions: [
			{
				id: "s1",
				title: "Проверить погоду в Сеуле",
				created_at: "2026-02-19T10:00:00Z",
				updated_at: "2026-02-19T10:05:00Z",
				message_count: 4,
			},
			{
				id: "s2",
				title: "Анализ структуры проекта",
				created_at: "2026-02-18T14:00:00Z",
				updated_at: "2026-02-18T14:30:00Z",
				message_count: 8,
			},
			{
				id: "s3",
				title: "Запрос на код-ревью",
				created_at: "2026-02-17T09:00:00Z",
				updated_at: "2026-02-17T09:20:00Z",
				message_count: 6,
			},
		],
		facts: [
			{
				id: "f1",
				key: "Любимый цвет",
				value: "Синий",
				created_at: "2026-02-19T10:00:00Z",
			},
			{
				id: "f2",
				key: "Имя",
				value: "Люк",
				created_at: "2026-02-18T09:00:00Z",
			},
			{
				id: "f3",
				key: "Профессия",
				value: "Разработчик",
				created_at: "2026-02-17T09:00:00Z",
			},
		],
		discordMessages: [
			{
				id: "m1",
				content: "Привет!",
				author: { id: "user-1", username: "Люк" },
				timestamp: "2026-02-19T10:00:00Z",
			},
			{
				id: "m2",
				content: "Привет! Чем могу помочь?",
				author: { id: "bot-1", username: "Naia", bot: true },
				timestamp: "2026-02-19T10:00:01Z",
			},
		],
		agentSession: {
			id: "sess-1",
			agentId: "agent-1",
			title: "Основная сессия",
			created_at: "2026-02-19T08:00:00Z",
			messageCount: 42,
		},
	},
	es: {
		sessions: [
			{
				id: "s1",
				title: "Consultar clima en Seúl",
				created_at: "2026-02-19T10:00:00Z",
				updated_at: "2026-02-19T10:05:00Z",
				message_count: 4,
			},
			{
				id: "s2",
				title: "Analizar estructura del proyecto",
				created_at: "2026-02-18T14:00:00Z",
				updated_at: "2026-02-18T14:30:00Z",
				message_count: 8,
			},
			{
				id: "s3",
				title: "Solicitud de revisión de código",
				created_at: "2026-02-17T09:00:00Z",
				updated_at: "2026-02-17T09:20:00Z",
				message_count: 6,
			},
		],
		facts: [
			{
				id: "f1",
				key: "Color favorito",
				value: "Azul",
				created_at: "2026-02-19T10:00:00Z",
			},
			{
				id: "f2",
				key: "Nombre",
				value: "Luke",
				created_at: "2026-02-18T09:00:00Z",
			},
			{
				id: "f3",
				key: "Ocupación",
				value: "Desarrollador",
				created_at: "2026-02-17T09:00:00Z",
			},
		],
		discordMessages: [
			{
				id: "m1",
				content: "¡Hola!",
				author: { id: "user-1", username: "Luke" },
				timestamp: "2026-02-19T10:00:00Z",
			},
			{
				id: "m2",
				content: "¡Hola! ¿En qué puedo ayudarte?",
				author: { id: "bot-1", username: "Naia", bot: true },
				timestamp: "2026-02-19T10:00:01Z",
			},
		],
		agentSession: {
			id: "sess-1",
			agentId: "agent-1",
			title: "Sesión principal",
			created_at: "2026-02-19T08:00:00Z",
			messageCount: 42,
		},
	},
	ar: {
		sessions: [
			{
				id: "s1",
				title: "التحقق من طقس سيول",
				created_at: "2026-02-19T10:00:00Z",
				updated_at: "2026-02-19T10:05:00Z",
				message_count: 4,
			},
			{
				id: "s2",
				title: "تحليل هيكل المشروع",
				created_at: "2026-02-18T14:00:00Z",
				updated_at: "2026-02-18T14:30:00Z",
				message_count: 8,
			},
			{
				id: "s3",
				title: "طلب مراجعة الكود",
				created_at: "2026-02-17T09:00:00Z",
				updated_at: "2026-02-17T09:20:00Z",
				message_count: 6,
			},
		],
		facts: [
			{
				id: "f1",
				key: "اللون المفضل",
				value: "أزرق",
				created_at: "2026-02-19T10:00:00Z",
			},
			{
				id: "f2",
				key: "الاسم",
				value: "لوك",
				created_at: "2026-02-18T09:00:00Z",
			},
			{
				id: "f3",
				key: "المهنة",
				value: "مطور",
				created_at: "2026-02-17T09:00:00Z",
			},
		],
		discordMessages: [
			{
				id: "m1",
				content: "مرحباً!",
				author: { id: "user-1", username: "لوك" },
				timestamp: "2026-02-19T10:00:00Z",
			},
			{
				id: "m2",
				content: "مرحباً! كيف يمكنني مساعدتك؟",
				author: { id: "bot-1", username: "Naia", bot: true },
				timestamp: "2026-02-19T10:00:01Z",
			},
		],
		agentSession: {
			id: "sess-1",
			agentId: "agent-1",
			title: "الجلسة الرئيسية",
			created_at: "2026-02-19T08:00:00Z",
			messageCount: 42,
		},
	},
	hi: {
		sessions: [
			{
				id: "s1",
				title: "सियोल का मौसम जांचें",
				created_at: "2026-02-19T10:00:00Z",
				updated_at: "2026-02-19T10:05:00Z",
				message_count: 4,
			},
			{
				id: "s2",
				title: "प्रोजेक्ट संरचना विश्लेषण",
				created_at: "2026-02-18T14:00:00Z",
				updated_at: "2026-02-18T14:30:00Z",
				message_count: 8,
			},
			{
				id: "s3",
				title: "कोड रिव्यू अनुरोध",
				created_at: "2026-02-17T09:00:00Z",
				updated_at: "2026-02-17T09:20:00Z",
				message_count: 6,
			},
		],
		facts: [
			{
				id: "f1",
				key: "पसंदीदा रंग",
				value: "नीला",
				created_at: "2026-02-19T10:00:00Z",
			},
			{
				id: "f2",
				key: "नाम",
				value: "ल्यूक",
				created_at: "2026-02-18T09:00:00Z",
			},
			{
				id: "f3",
				key: "पेशा",
				value: "डेवलपर",
				created_at: "2026-02-17T09:00:00Z",
			},
		],
		discordMessages: [
			{
				id: "m1",
				content: "नमस्ते!",
				author: { id: "user-1", username: "ल्यूक" },
				timestamp: "2026-02-19T10:00:00Z",
			},
			{
				id: "m2",
				content: "नमस्ते! मैं कैसे मदद कर सकती हूँ?",
				author: { id: "bot-1", username: "Naia", bot: true },
				timestamp: "2026-02-19T10:00:01Z",
			},
		],
		agentSession: {
			id: "sess-1",
			agentId: "agent-1",
			title: "मुख्य सत्र",
			created_at: "2026-02-19T08:00:00Z",
			messageCount: 42,
		},
	},
	bn: {
		sessions: [
			{
				id: "s1",
				title: "সিউলের আবহাওয়া পরীক্ষা",
				created_at: "2026-02-19T10:00:00Z",
				updated_at: "2026-02-19T10:05:00Z",
				message_count: 4,
			},
			{
				id: "s2",
				title: "প্রজেক্ট কাঠামো বিশ্লেষণ",
				created_at: "2026-02-18T14:00:00Z",
				updated_at: "2026-02-18T14:30:00Z",
				message_count: 8,
			},
			{
				id: "s3",
				title: "কোড রিভিউ অনুরোধ",
				created_at: "2026-02-17T09:00:00Z",
				updated_at: "2026-02-17T09:20:00Z",
				message_count: 6,
			},
		],
		facts: [
			{
				id: "f1",
				key: "প্রিয় রং",
				value: "নীল",
				created_at: "2026-02-19T10:00:00Z",
			},
			{ id: "f2", key: "নাম", value: "লুক", created_at: "2026-02-18T09:00:00Z" },
			{
				id: "f3",
				key: "পেশা",
				value: "ডেভেলপার",
				created_at: "2026-02-17T09:00:00Z",
			},
		],
		discordMessages: [
			{
				id: "m1",
				content: "হ্যালো!",
				author: { id: "user-1", username: "লুক" },
				timestamp: "2026-02-19T10:00:00Z",
			},
			{
				id: "m2",
				content: "হ্যালো! কীভাবে সাহায্য করতে পারি?",
				author: { id: "bot-1", username: "Naia", bot: true },
				timestamp: "2026-02-19T10:00:01Z",
			},
		],
		agentSession: {
			id: "sess-1",
			agentId: "agent-1",
			title: "প্রধান সেশন",
			created_at: "2026-02-19T08:00:00Z",
			messageCount: 42,
		},
	},
	pt: {
		sessions: [
			{
				id: "s1",
				title: "Verificar clima em Seul",
				created_at: "2026-02-19T10:00:00Z",
				updated_at: "2026-02-19T10:05:00Z",
				message_count: 4,
			},
			{
				id: "s2",
				title: "Analisar estrutura do projeto",
				created_at: "2026-02-18T14:00:00Z",
				updated_at: "2026-02-18T14:30:00Z",
				message_count: 8,
			},
			{
				id: "s3",
				title: "Solicitação de revisão de código",
				created_at: "2026-02-17T09:00:00Z",
				updated_at: "2026-02-17T09:20:00Z",
				message_count: 6,
			},
		],
		facts: [
			{
				id: "f1",
				key: "Cor favorita",
				value: "Azul",
				created_at: "2026-02-19T10:00:00Z",
			},
			{
				id: "f2",
				key: "Nome",
				value: "Luke",
				created_at: "2026-02-18T09:00:00Z",
			},
			{
				id: "f3",
				key: "Profissão",
				value: "Desenvolvedor",
				created_at: "2026-02-17T09:00:00Z",
			},
		],
		discordMessages: [
			{
				id: "m1",
				content: "Olá!",
				author: { id: "user-1", username: "Luke" },
				timestamp: "2026-02-19T10:00:00Z",
			},
			{
				id: "m2",
				content: "Olá! Como posso ajudar?",
				author: { id: "bot-1", username: "Naia", bot: true },
				timestamp: "2026-02-19T10:00:01Z",
			},
		],
		agentSession: {
			id: "sess-1",
			agentId: "agent-1",
			title: "Sessão principal",
			created_at: "2026-02-19T08:00:00Z",
			messageCount: 42,
		},
	},
	id: {
		sessions: [
			{
				id: "s1",
				title: "Cek cuaca di Seoul",
				created_at: "2026-02-19T10:00:00Z",
				updated_at: "2026-02-19T10:05:00Z",
				message_count: 4,
			},
			{
				id: "s2",
				title: "Analisis struktur proyek",
				created_at: "2026-02-18T14:00:00Z",
				updated_at: "2026-02-18T14:30:00Z",
				message_count: 8,
			},
			{
				id: "s3",
				title: "Permintaan tinjauan kode",
				created_at: "2026-02-17T09:00:00Z",
				updated_at: "2026-02-17T09:20:00Z",
				message_count: 6,
			},
		],
		facts: [
			{
				id: "f1",
				key: "Warna favorit",
				value: "Biru",
				created_at: "2026-02-19T10:00:00Z",
			},
			{
				id: "f2",
				key: "Nama",
				value: "Luke",
				created_at: "2026-02-18T09:00:00Z",
			},
			{
				id: "f3",
				key: "Pekerjaan",
				value: "Developer",
				created_at: "2026-02-17T09:00:00Z",
			},
		],
		discordMessages: [
			{
				id: "m1",
				content: "Halo!",
				author: { id: "user-1", username: "Luke" },
				timestamp: "2026-02-19T10:00:00Z",
			},
			{
				id: "m2",
				content: "Halo! Ada yang bisa saya bantu?",
				author: { id: "bot-1", username: "Naia", bot: true },
				timestamp: "2026-02-19T10:00:01Z",
			},
		],
		agentSession: {
			id: "sess-1",
			agentId: "agent-1",
			title: "Sesi utama",
			created_at: "2026-02-19T08:00:00Z",
			messageCount: 42,
		},
	},
	vi: {
		sessions: [
			{
				id: "s1",
				title: "Kiểm tra thời tiết Seoul",
				created_at: "2026-02-19T10:00:00Z",
				updated_at: "2026-02-19T10:05:00Z",
				message_count: 4,
			},
			{
				id: "s2",
				title: "Phân tích cấu trúc dự án",
				created_at: "2026-02-18T14:00:00Z",
				updated_at: "2026-02-18T14:30:00Z",
				message_count: 8,
			},
			{
				id: "s3",
				title: "Yêu cầu đánh giá mã nguồn",
				created_at: "2026-02-17T09:00:00Z",
				updated_at: "2026-02-17T09:20:00Z",
				message_count: 6,
			},
		],
		facts: [
			{
				id: "f1",
				key: "Màu yêu thích",
				value: "Xanh dương",
				created_at: "2026-02-19T10:00:00Z",
			},
			{
				id: "f2",
				key: "Tên",
				value: "Luke",
				created_at: "2026-02-18T09:00:00Z",
			},
			{
				id: "f3",
				key: "Nghề nghiệp",
				value: "Lập trình viên",
				created_at: "2026-02-17T09:00:00Z",
			},
		],
		discordMessages: [
			{
				id: "m1",
				content: "Xin chào!",
				author: { id: "user-1", username: "Luke" },
				timestamp: "2026-02-19T10:00:00Z",
			},
			{
				id: "m2",
				content: "Xin chào! Tôi có thể giúp gì?",
				author: { id: "bot-1", username: "Naia", bot: true },
				timestamp: "2026-02-19T10:00:01Z",
			},
		],
		agentSession: {
			id: "sess-1",
			agentId: "agent-1",
			title: "Phiên chính",
			created_at: "2026-02-19T08:00:00Z",
			messageCount: 42,
		},
	},
};

/** Settings section divider texts per language (for scrolling in demo recording) */
export const DEMO_SECTION_LABELS: Record<
	NarrationLang,
	{ voice: string; memory: string }
> = {
	ko: { voice: "음성", memory: "기억" },
	en: { voice: "Voice", memory: "Memory" },
	ja: { voice: "音声", memory: "記憶" },
	zh: { voice: "语音", memory: "记忆" },
	fr: { voice: "Voix", memory: "Mémoire" },
	de: { voice: "Sprache", memory: "Gedächtnis" },
	ru: { voice: "Голос", memory: "Память" },
	es: { voice: "Voz", memory: "Memoria" },
	ar: { voice: "الصوت", memory: "الذاكرة" },
	hi: { voice: "आवाज", memory: "स्मृति" },
	bn: { voice: "ভয়েস", memory: "স্মৃতি" },
	pt: { voice: "Voz", memory: "Memória" },
	id: { voice: "Suara", memory: "Memori" },
	vi: { voice: "Giọng", memory: "Bộ nhớ" },
};

/** Google Cloud TTS voice mapping per language */
export const TTS_VOICES: Record<
	NarrationLang,
	{ languageCode: string; voiceName: string }
> = {
	ko: { languageCode: "ko-KR", voiceName: "ko-KR-Neural2-A" },
	en: { languageCode: "en-US", voiceName: "en-US-Neural2-F" },
	ja: { languageCode: "ja-JP", voiceName: "ja-JP-Neural2-B" },
	zh: { languageCode: "cmn-CN", voiceName: "cmn-CN-Wavenet-A" },
	fr: { languageCode: "fr-FR", voiceName: "fr-FR-Neural2-A" },
	de: { languageCode: "de-DE", voiceName: "de-DE-Neural2-A" },
	ru: { languageCode: "ru-RU", voiceName: "ru-RU-Wavenet-A" },
	es: { languageCode: "es-ES", voiceName: "es-ES-Neural2-A" },
	ar: { languageCode: "ar-XA", voiceName: "ar-XA-Wavenet-A" },
	hi: { languageCode: "hi-IN", voiceName: "hi-IN-Neural2-A" },
	bn: { languageCode: "bn-IN", voiceName: "bn-IN-Wavenet-A" },
	pt: { languageCode: "pt-BR", voiceName: "pt-BR-Neural2-A" },
	id: { languageCode: "id-ID", voiceName: "id-ID-Wavenet-A" },
	vi: { languageCode: "vi-VN", voiceName: "vi-VN-Neural2-A" },
};
