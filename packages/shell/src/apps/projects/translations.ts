import { type Locale, getLocale } from "../../lib/i18n";

const english = {
	"projects.title": "Projects",
	"projects.chooseTitle": "Choose a project",
	"projects.checkoutLabel": "Checkout",
	"projects.chooseCheckout": "Choose checkout",
	"projects.changeCheckout": "Change checkout",
	"projects.noCheckoutTitle": "Choose a naia-pj-adk checkout",
	"projects.noCheckoutHint":
		"Select the checkout that contains the projects you want to browse. The project views are placeholders in this stage.",
	"projects.loading": "Reading projects and configuration…",
	"projects.checkoutError": "This checkout could not be read",
	"projects.checkoutErrorHint":
		"Choose a naia-pj-adk checkout with a readable projects folder, then try again.",
	"projects.chooseAnother": "Choose another checkout",
	"projects.catalogLabel": "Project catalog",
	"projects.searchLabel": "Search projects",
	"projects.searchPlaceholder": "Search by name, ID, or repository",
	"projects.emptyTitle": "No projects found",
	"projects.emptyHint":
		"Check the checkout's projects/ folder or choose another checkout.",
	"projects.noSearchResults": "No projects match this search.",
	"projects.unavailable": "Unavailable",
	"projects.configError":
		"This project has a configuration problem and cannot be opened.",
	"projects.configErrorHint":
		"Check the listed file and its project settings, then choose the checkout again.",
	"projects.fileMissing": "is missing.",
	"projects.fileUnreadable": "could not be read.",
	"projects.fileInvalid": "is invalid.",
	"projects.projectIdMissing": "The project ID is missing.",
	"projects.profileMissing": "The project profile is missing.",
	"projects.unsafePath":
		"The file points outside the selected checkout and was not read.",
	"projects.selected": "Selected",
	"projects.selectedProject": "Selected project",
	"projects.tabsLabel": "Project views",
	"projects.tabCodingAgent": "Coding Agent",
	"projects.tabDashboard": "Dashboard",
	"projects.tabInternalIssues": "Internal Issues",
	"projects.stageOneEmpty":
		"This view is a stage 1 placeholder. Runtime and issue data are not connected.",
	"projects.selectTitle": "Select a project",
	"projects.selectHint":
		"Choose a ready project from the list to open its views.",
	"projects.projectContent": "Selected project content",
} as const;

type ProjectTranslationKey = keyof typeof english;

export const PROJECT_APP_TRANSLATIONS: Record<
	Locale,
	Record<ProjectTranslationKey, string>
> = {
	en: english,
	ko: {
		"projects.title": "프로젝트",
		"projects.chooseTitle": "프로젝트 선택",
		"projects.checkoutLabel": "체크아웃",
		"projects.chooseCheckout": "체크아웃 선택",
		"projects.changeCheckout": "체크아웃 변경",
		"projects.noCheckoutTitle": "naia-pj-adk 체크아웃을 선택하세요",
		"projects.noCheckoutHint":
			"확인할 프로젝트가 들어 있는 체크아웃을 선택하세요. 이 단계의 프로젝트 화면은 뼈대만 제공합니다.",
		"projects.loading": "프로젝트와 설정을 읽는 중…",
		"projects.checkoutError": "체크아웃을 읽지 못했습니다",
		"projects.checkoutErrorHint":
			"projects/ 폴더를 읽을 수 있는 naia-pj-adk 체크아웃을 선택한 뒤 다시 시도하세요.",
		"projects.chooseAnother": "다른 체크아웃 선택",
		"projects.catalogLabel": "프로젝트 목록",
		"projects.searchLabel": "프로젝트 검색",
		"projects.searchPlaceholder": "이름, ID, repository로 검색",
		"projects.emptyTitle": "프로젝트가 없습니다",
		"projects.emptyHint":
			"체크아웃의 projects/ 폴더를 확인하거나 다른 체크아웃을 선택하세요.",
		"projects.noSearchResults": "검색 결과가 없습니다.",
		"projects.unavailable": "사용 불가",
		"projects.configError": "설정 문제가 있어 이 프로젝트를 열 수 없습니다.",
		"projects.configErrorHint":
			"표시된 파일과 프로젝트 설정을 확인한 뒤 체크아웃을 다시 선택하세요.",
		"projects.fileMissing": "파일이 없습니다.",
		"projects.fileUnreadable": "읽을 수 없습니다.",
		"projects.fileInvalid": "형식이 올바르지 않습니다.",
		"projects.projectIdMissing": "프로젝트 ID가 없습니다.",
		"projects.profileMissing": "프로젝트 profile이 없습니다.",
		"projects.unsafePath":
			"선택한 체크아웃 바깥을 가리켜 파일을 읽지 않았습니다.",
		"projects.selected": "선택됨",
		"projects.selectedProject": "선택한 프로젝트",
		"projects.tabsLabel": "프로젝트 화면",
		"projects.tabCodingAgent": "코딩 에이전트",
		"projects.tabDashboard": "대시보드",
		"projects.tabInternalIssues": "내부 이슈",
		"projects.stageOneEmpty":
			"1단계 빈 화면입니다. 실행 환경과 이슈 데이터는 연결하지 않았습니다.",
		"projects.selectTitle": "프로젝트를 선택하세요",
		"projects.selectHint":
			"목록에서 설정이 올바른 프로젝트를 선택하면 화면을 엽니다.",
		"projects.projectContent": "선택한 프로젝트 내용",
	},
	ja: {
		"projects.title": "プロジェクト",
		"projects.chooseTitle": "プロジェクトを選択",
		"projects.checkoutLabel": "チェックアウト",
		"projects.chooseCheckout": "チェックアウトを選択",
		"projects.changeCheckout": "チェックアウトを変更",
		"projects.noCheckoutTitle":
			"naia-pj-adk のチェックアウトを選択してください",
		"projects.noCheckoutHint":
			"確認するプロジェクトが含まれるチェックアウトを選択してください。この段階の画面はプレースホルダーです。",
		"projects.loading": "プロジェクトと設定を読み込み中…",
		"projects.checkoutError": "チェックアウトを読み込めませんでした",
		"projects.checkoutErrorHint":
			"projects/ フォルダーを読み取れる naia-pj-adk チェックアウトを選んで再試行してください。",
		"projects.chooseAnother": "別のチェックアウトを選択",
		"projects.catalogLabel": "プロジェクト一覧",
		"projects.searchLabel": "プロジェクトを検索",
		"projects.searchPlaceholder": "名前、ID、repository で検索",
		"projects.emptyTitle": "プロジェクトがありません",
		"projects.emptyHint":
			"チェックアウトの projects/ フォルダーを確認するか、別のチェックアウトを選択してください。",
		"projects.noSearchResults": "一致するプロジェクトはありません。",
		"projects.unavailable": "利用不可",
		"projects.configError":
			"設定に問題があるため、このプロジェクトは開けません。",
		"projects.configErrorHint":
			"表示されたファイルと設定を確認してから、チェックアウトを選び直してください。",
		"projects.fileMissing": "がありません。",
		"projects.fileUnreadable": "読み込めません。",
		"projects.fileInvalid": "の形式が正しくありません。",
		"projects.projectIdMissing": "プロジェクト ID がありません。",
		"projects.profileMissing": "プロジェクト profile がありません。",
		"projects.unsafePath":
			"選択したチェックアウト外を指すため、ファイルを読み込みませんでした。",
		"projects.selected": "選択済み",
		"projects.selectedProject": "選択中のプロジェクト",
		"projects.tabsLabel": "プロジェクト画面",
		"projects.tabCodingAgent": "コーディングエージェント",
		"projects.tabDashboard": "ダッシュボード",
		"projects.tabInternalIssues": "内部 Issue",
		"projects.stageOneEmpty":
			"ステージ 1 のプレースホルダーです。実行環境や Issue データは接続されていません。",
		"projects.selectTitle": "プロジェクトを選択",
		"projects.selectHint":
			"一覧から設定に問題のないプロジェクトを選ぶと画面を開きます。",
		"projects.projectContent": "選択したプロジェクトの内容",
	},
	zh: {
		"projects.title": "项目",
		"projects.chooseTitle": "选择项目",
		"projects.checkoutLabel": "检出目录",
		"projects.chooseCheckout": "选择检出目录",
		"projects.changeCheckout": "更改检出目录",
		"projects.noCheckoutTitle": "请选择 naia-pj-adk 检出目录",
		"projects.noCheckoutHint":
			"选择包含要查看项目的检出目录。本阶段的项目视图仅为占位界面。",
		"projects.loading": "正在读取项目和配置…",
		"projects.checkoutError": "无法读取此检出目录",
		"projects.checkoutErrorHint":
			"请选择包含可读取 projects/ 文件夹的 naia-pj-adk 检出目录，然后重试。",
		"projects.chooseAnother": "选择其他检出目录",
		"projects.catalogLabel": "项目目录",
		"projects.searchLabel": "搜索项目",
		"projects.searchPlaceholder": "按名称、ID 或 repository 搜索",
		"projects.emptyTitle": "未找到项目",
		"projects.emptyHint":
			"检查检出目录中的 projects/ 文件夹，或选择其他检出目录。",
		"projects.noSearchResults": "没有匹配的项目。",
		"projects.unavailable": "不可用",
		"projects.configError": "配置有问题，无法打开此项目。",
		"projects.configErrorHint":
			"检查列出的文件和项目设置，然后重新选择检出目录。",
		"projects.fileMissing": "缺失。",
		"projects.fileUnreadable": "无法读取。",
		"projects.fileInvalid": "格式无效。",
		"projects.projectIdMissing": "缺少项目 ID。",
		"projects.profileMissing": "缺少项目 profile。",
		"projects.unsafePath": "文件指向所选检出目录之外，因此未读取该文件。",
		"projects.selected": "已选择",
		"projects.selectedProject": "已选项目",
		"projects.tabsLabel": "项目视图",
		"projects.tabCodingAgent": "编码代理",
		"projects.tabDashboard": "仪表板",
		"projects.tabInternalIssues": "内部问题",
		"projects.stageOneEmpty":
			"这是阶段 1 的占位视图。尚未连接运行环境或问题数据。",
		"projects.selectTitle": "选择一个项目",
		"projects.selectHint": "从列表中选择配置有效的项目以打开其视图。",
		"projects.projectContent": "所选项目内容",
	},
	fr: {
		"projects.title": "Projets",
		"projects.chooseTitle": "Choisir un projet",
		"projects.checkoutLabel": "Dépôt",
		"projects.chooseCheckout": "Choisir un dépôt",
		"projects.changeCheckout": "Changer de dépôt",
		"projects.noCheckoutTitle": "Choisissez un dépôt naia-pj-adk",
		"projects.noCheckoutHint":
			"Sélectionnez le dépôt contenant les projets à consulter. Les vues sont des espaces réservés à cette étape.",
		"projects.loading": "Lecture des projets et de la configuration…",
		"projects.checkoutError": "Impossible de lire ce dépôt",
		"projects.checkoutErrorHint":
			"Choisissez un dépôt naia-pj-adk avec un dossier projects/ lisible, puis réessayez.",
		"projects.chooseAnother": "Choisir un autre dépôt",
		"projects.catalogLabel": "Catalogue des projets",
		"projects.searchLabel": "Rechercher des projets",
		"projects.searchPlaceholder": "Rechercher par nom, ID ou repository",
		"projects.emptyTitle": "Aucun projet trouvé",
		"projects.emptyHint":
			"Vérifiez le dossier projects/ du dépôt ou choisissez un autre dépôt.",
		"projects.noSearchResults": "Aucun projet ne correspond à cette recherche.",
		"projects.unavailable": "Indisponible",
		"projects.configError":
			"La configuration empêche l'ouverture de ce projet.",
		"projects.configErrorHint":
			"Vérifiez le fichier indiqué et les paramètres du projet, puis sélectionnez à nouveau le dépôt.",
		"projects.fileMissing": "est introuvable.",
		"projects.fileUnreadable": "est illisible.",
		"projects.fileInvalid": "est invalide.",
		"projects.projectIdMissing": "L'ID du projet est manquant.",
		"projects.profileMissing": "Le profil du projet est manquant.",
		"projects.unsafePath":
			"Le fichier pointe hors du dépôt sélectionné et n'a pas été lu.",
		"projects.selected": "Sélectionné",
		"projects.selectedProject": "Projet sélectionné",
		"projects.tabsLabel": "Vues du projet",
		"projects.tabCodingAgent": "Agent de code",
		"projects.tabDashboard": "Tableau de bord",
		"projects.tabInternalIssues": "Incidents internes",
		"projects.stageOneEmpty":
			"Espace réservé de l'étape 1. L'exécution et les données d'incidents ne sont pas connectées.",
		"projects.selectTitle": "Sélectionnez un projet",
		"projects.selectHint":
			"Choisissez un projet valide dans la liste pour ouvrir ses vues.",
		"projects.projectContent": "Contenu du projet sélectionné",
	},
	de: {
		"projects.title": "Projekte",
		"projects.chooseTitle": "Projekt auswählen",
		"projects.checkoutLabel": "Checkout",
		"projects.chooseCheckout": "Checkout auswählen",
		"projects.changeCheckout": "Checkout ändern",
		"projects.noCheckoutTitle": "Wähle einen naia-pj-adk-Checkout",
		"projects.noCheckoutHint":
			"Wähle den Checkout mit den gewünschten Projekten. Die Ansichten sind in dieser Stufe Platzhalter.",
		"projects.loading": "Projekte und Konfiguration werden gelesen…",
		"projects.checkoutError": "Dieser Checkout konnte nicht gelesen werden",
		"projects.checkoutErrorHint":
			"Wähle einen naia-pj-adk-Checkout mit lesbarem projects/-Ordner und versuche es erneut.",
		"projects.chooseAnother": "Anderen Checkout wählen",
		"projects.catalogLabel": "Projektkatalog",
		"projects.searchLabel": "Projekte suchen",
		"projects.searchPlaceholder": "Nach Name, ID oder Repository suchen",
		"projects.emptyTitle": "Keine Projekte gefunden",
		"projects.emptyHint":
			"Prüfe den projects/-Ordner oder wähle einen anderen Checkout.",
		"projects.noSearchResults": "Keine Projekte für diese Suche.",
		"projects.unavailable": "Nicht verfügbar",
		"projects.configError":
			"Ein Konfigurationsproblem verhindert das Öffnen dieses Projekts.",
		"projects.configErrorHint":
			"Prüfe die angegebene Datei und die Projekteinstellungen und wähle den Checkout erneut.",
		"projects.fileMissing": "fehlt.",
		"projects.fileUnreadable": "konnte nicht gelesen werden.",
		"projects.fileInvalid": "ist ungültig.",
		"projects.projectIdMissing": "Die Projekt-ID fehlt.",
		"projects.profileMissing": "Das Projektprofil fehlt.",
		"projects.unsafePath":
			"Die Datei verweist außerhalb des ausgewählten Checkouts und wurde nicht gelesen.",
		"projects.selected": "Ausgewählt",
		"projects.selectedProject": "Ausgewähltes Projekt",
		"projects.tabsLabel": "Projektansichten",
		"projects.tabCodingAgent": "Programmieragent",
		"projects.tabDashboard": "Dashboard",
		"projects.tabInternalIssues": "Interne Issues",
		"projects.stageOneEmpty":
			"Platzhalter der Stufe 1. Laufzeit und Issue-Daten sind nicht verbunden.",
		"projects.selectTitle": "Projekt auswählen",
		"projects.selectHint":
			"Wähle ein gültig konfiguriertes Projekt aus der Liste.",
		"projects.projectContent": "Inhalt des ausgewählten Projekts",
	},
	ru: {
		"projects.title": "Проекты",
		"projects.chooseTitle": "Выберите проект",
		"projects.checkoutLabel": "Рабочая копия",
		"projects.chooseCheckout": "Выбрать рабочую копию",
		"projects.changeCheckout": "Сменить рабочую копию",
		"projects.noCheckoutTitle": "Выберите рабочую копию naia-pj-adk",
		"projects.noCheckoutHint":
			"Выберите копию с нужными проектами. На этом этапе экраны проектов являются заглушками.",
		"projects.loading": "Чтение проектов и конфигурации…",
		"projects.checkoutError": "Не удалось прочитать эту рабочую копию",
		"projects.checkoutErrorHint":
			"Выберите naia-pj-adk с доступной папкой projects/ и повторите попытку.",
		"projects.chooseAnother": "Выбрать другую копию",
		"projects.catalogLabel": "Каталог проектов",
		"projects.searchLabel": "Поиск проектов",
		"projects.searchPlaceholder": "Поиск по имени, ID или repository",
		"projects.emptyTitle": "Проекты не найдены",
		"projects.emptyHint":
			"Проверьте папку projects/ или выберите другую рабочую копию.",
		"projects.noSearchResults": "Совпадений нет.",
		"projects.unavailable": "Недоступен",
		"projects.configError": "Конфигурация не позволяет открыть этот проект.",
		"projects.configErrorHint":
			"Проверьте указанный файл и настройки проекта, затем выберите рабочую копию снова.",
		"projects.fileMissing": "отсутствует.",
		"projects.fileUnreadable": "не удалось прочитать.",
		"projects.fileInvalid": "имеет неверный формат.",
		"projects.projectIdMissing": "Не указан ID проекта.",
		"projects.profileMissing": "Не указан профиль проекта.",
		"projects.unsafePath":
			"Файл находится вне выбранной копии; он не был прочитан.",
		"projects.selected": "Выбран",
		"projects.selectedProject": "Выбранный проект",
		"projects.tabsLabel": "Представления проекта",
		"projects.tabCodingAgent": "Агент-кодировщик",
		"projects.tabDashboard": "Панель",
		"projects.tabInternalIssues": "Внутренние задачи",
		"projects.stageOneEmpty":
			"Заглушка этапа 1. Среда выполнения и данные задач не подключены.",
		"projects.selectTitle": "Выберите проект",
		"projects.selectHint":
			"Выберите в списке проект с корректной конфигурацией.",
		"projects.projectContent": "Содержимое выбранного проекта",
	},
	es: {
		"projects.title": "Proyectos",
		"projects.chooseTitle": "Elegir proyecto",
		"projects.checkoutLabel": "Checkout",
		"projects.chooseCheckout": "Elegir checkout",
		"projects.changeCheckout": "Cambiar checkout",
		"projects.noCheckoutTitle": "Elige un checkout de naia-pj-adk",
		"projects.noCheckoutHint":
			"Selecciona el checkout que contiene los proyectos que quieres consultar. Estas vistas son provisionales en esta etapa.",
		"projects.loading": "Leyendo proyectos y configuración…",
		"projects.checkoutError": "No se pudo leer este checkout",
		"projects.checkoutErrorHint":
			"Elige un checkout naia-pj-adk con una carpeta projects/ legible e inténtalo de nuevo.",
		"projects.chooseAnother": "Elegir otro checkout",
		"projects.catalogLabel": "Catálogo de proyectos",
		"projects.searchLabel": "Buscar proyectos",
		"projects.searchPlaceholder": "Buscar por nombre, ID o repository",
		"projects.emptyTitle": "No se encontraron proyectos",
		"projects.emptyHint": "Revisa la carpeta projects/ o elige otro checkout.",
		"projects.noSearchResults": "Ningún proyecto coincide con esta búsqueda.",
		"projects.unavailable": "No disponible",
		"projects.configError":
			"Hay un problema de configuración y no se puede abrir este proyecto.",
		"projects.configErrorHint":
			"Revisa el archivo indicado y la configuración del proyecto; después, vuelve a elegir el checkout.",
		"projects.fileMissing": "falta.",
		"projects.fileUnreadable": "no se pudo leer.",
		"projects.fileInvalid": "no tiene un formato válido.",
		"projects.projectIdMissing": "Falta el ID del proyecto.",
		"projects.profileMissing": "Falta el perfil del proyecto.",
		"projects.unsafePath":
			"El archivo apunta fuera del checkout seleccionado y no se leyó.",
		"projects.selected": "Seleccionado",
		"projects.selectedProject": "Proyecto seleccionado",
		"projects.tabsLabel": "Vistas del proyecto",
		"projects.tabCodingAgent": "Agente de código",
		"projects.tabDashboard": "Panel",
		"projects.tabInternalIssues": "Incidencias internas",
		"projects.stageOneEmpty":
			"Vista provisional de la etapa 1. El entorno de ejecución y los datos de incidencias no están conectados.",
		"projects.selectTitle": "Selecciona un proyecto",
		"projects.selectHint":
			"Elige un proyecto válido de la lista para abrir sus vistas.",
		"projects.projectContent": "Contenido del proyecto seleccionado",
	},
	ar: {
		"projects.title": "المشاريع",
		"projects.chooseTitle": "اختر مشروعًا",
		"projects.checkoutLabel": "نسخة العمل",
		"projects.chooseCheckout": "اختيار نسخة العمل",
		"projects.changeCheckout": "تغيير نسخة العمل",
		"projects.noCheckoutTitle": "اختر نسخة naia-pj-adk",
		"projects.noCheckoutHint":
			"اختر نسخة العمل التي تحتوي على المشاريع المطلوبة. هذه الشاشات مؤقتة في هذه المرحلة.",
		"projects.loading": "جارٍ قراءة المشاريع والإعدادات…",
		"projects.checkoutError": "تعذرت قراءة نسخة العمل هذه",
		"projects.checkoutErrorHint":
			"اختر نسخة naia-pj-adk تحتوي على مجلد projects/ قابل للقراءة ثم أعد المحاولة.",
		"projects.chooseAnother": "اختيار نسخة أخرى",
		"projects.catalogLabel": "كتالوج المشاريع",
		"projects.searchLabel": "البحث عن المشاريع",
		"projects.searchPlaceholder": "البحث بالاسم أو ID أو repository",
		"projects.emptyTitle": "لم يتم العثور على مشاريع",
		"projects.emptyHint": "تحقق من مجلد projects/ أو اختر نسخة عمل أخرى.",
		"projects.noSearchResults": "لا توجد مشاريع تطابق البحث.",
		"projects.unavailable": "غير متاح",
		"projects.configError": "توجد مشكلة في الإعدادات تمنع فتح هذا المشروع.",
		"projects.configErrorHint":
			"تحقق من الملف وإعدادات المشروع ثم اختر نسخة العمل مرة أخرى.",
		"projects.fileMissing": "غير موجود.",
		"projects.fileUnreadable": "تعذرت قراءته.",
		"projects.fileInvalid": "تنسيقه غير صالح.",
		"projects.projectIdMissing": "معرّف المشروع غير موجود.",
		"projects.profileMissing": "ملف profile للمشروع غير موجود.",
		"projects.unsafePath":
			"يشير الملف إلى خارج نسخة العمل المحددة، لذلك لم تتم قراءته.",
		"projects.selected": "محدد",
		"projects.selectedProject": "المشروع المحدد",
		"projects.tabsLabel": "واجهات المشروع",
		"projects.tabCodingAgent": "وكيل البرمجة",
		"projects.tabDashboard": "لوحة المعلومات",
		"projects.tabInternalIssues": "المشكلات الداخلية",
		"projects.stageOneEmpty":
			"واجهة مؤقتة للمرحلة الأولى. لم يتم ربط بيئة التشغيل أو بيانات المشكلات.",
		"projects.selectTitle": "اختر مشروعًا",
		"projects.selectHint":
			"اختر مشروعًا بإعدادات سليمة من القائمة لفتح واجهاته.",
		"projects.projectContent": "محتوى المشروع المحدد",
	},
	hi: {
		"projects.title": "प्रोजेक्ट",
		"projects.chooseTitle": "प्रोजेक्ट चुनें",
		"projects.checkoutLabel": "चेकआउट",
		"projects.chooseCheckout": "चेकआउट चुनें",
		"projects.changeCheckout": "चेकआउट बदलें",
		"projects.noCheckoutTitle": "naia-pj-adk चेकआउट चुनें",
		"projects.noCheckoutHint":
			"जिस चेकआउट में आपके प्रोजेक्ट हैं उसे चुनें। इस चरण में प्रोजेक्ट दृश्य केवल प्रारंभिक रूप हैं।",
		"projects.loading": "प्रोजेक्ट और कॉन्फ़िगरेशन पढ़े जा रहे हैं…",
		"projects.checkoutError": "यह चेकआउट पढ़ा नहीं जा सका",
		"projects.checkoutErrorHint":
			"पढ़ने योग्य projects/ फ़ोल्डर वाला naia-pj-adk चेकआउट चुनें और फिर प्रयास करें।",
		"projects.chooseAnother": "दूसरा चेकआउट चुनें",
		"projects.catalogLabel": "प्रोजेक्ट सूची",
		"projects.searchLabel": "प्रोजेक्ट खोजें",
		"projects.searchPlaceholder": "नाम, ID या repository से खोजें",
		"projects.emptyTitle": "कोई प्रोजेक्ट नहीं मिला",
		"projects.emptyHint": "चेकआउट का projects/ फ़ोल्डर देखें या दूसरा चेकआउट चुनें।",
		"projects.noSearchResults": "इस खोज से कोई प्रोजेक्ट नहीं मिला।",
		"projects.unavailable": "उपलब्ध नहीं",
		"projects.configError": "कॉन्फ़िगरेशन समस्या के कारण यह प्रोजेक्ट नहीं खुल सकता।",
		"projects.configErrorHint":
			"सूचीबद्ध फ़ाइल और प्रोजेक्ट सेटिंग जाँचें, फिर चेकआउट दोबारा चुनें।",
		"projects.fileMissing": "मौजूद नहीं है।",
		"projects.fileUnreadable": "पढ़ा नहीं जा सका।",
		"projects.fileInvalid": "प्रारूप अमान्य है।",
		"projects.projectIdMissing": "प्रोजेक्ट ID मौजूद नहीं है।",
		"projects.profileMissing": "प्रोजेक्ट profile मौजूद नहीं है।",
		"projects.unsafePath": "फ़ाइल चुने गए चेकआउट के बाहर है, इसलिए इसे नहीं पढ़ा गया।",
		"projects.selected": "चुना गया",
		"projects.selectedProject": "चुना गया प्रोजेक्ट",
		"projects.tabsLabel": "प्रोजेक्ट दृश्य",
		"projects.tabCodingAgent": "कोडिंग एजेंट",
		"projects.tabDashboard": "डैशबोर्ड",
		"projects.tabInternalIssues": "आंतरिक समस्याएँ",
		"projects.stageOneEmpty":
			"चरण 1 का प्रारंभिक दृश्य। रनटाइम और समस्या डेटा कनेक्ट नहीं हैं।",
		"projects.selectTitle": "प्रोजेक्ट चुनें",
		"projects.selectHint": "दृश्य खोलने के लिए सूची से सही कॉन्फ़िगरेशन वाला प्रोजेक्ट चुनें।",
		"projects.projectContent": "चुने गए प्रोजेक्ट की सामग्री",
	},
	bn: {
		"projects.title": "প্রকল্প",
		"projects.chooseTitle": "প্রকল্প বেছে নিন",
		"projects.checkoutLabel": "চেকআউট",
		"projects.chooseCheckout": "চেকআউট বেছে নিন",
		"projects.changeCheckout": "চেকআউট পরিবর্তন",
		"projects.noCheckoutTitle": "একটি naia-pj-adk চেকআউট বেছে নিন",
		"projects.noCheckoutHint":
			"যে চেকআউটে আপনার প্রকল্প আছে সেটি বেছে নিন। এই ধাপে প্রকল্পের দৃশ্যগুলো প্রাথমিক কাঠামো।",
		"projects.loading": "প্রকল্প ও কনফিগারেশন পড়া হচ্ছে…",
		"projects.checkoutError": "এই চেকআউট পড়া যায়নি",
		"projects.checkoutErrorHint":
			"পাঠযোগ্য projects/ ফোল্ডারসহ naia-pj-adk চেকআউট বেছে নিয়ে আবার চেষ্টা করুন।",
		"projects.chooseAnother": "অন্য চেকআউট বেছে নিন",
		"projects.catalogLabel": "প্রকল্প তালিকা",
		"projects.searchLabel": "প্রকল্প খুঁজুন",
		"projects.searchPlaceholder": "নাম, ID বা repository দিয়ে খুঁজুন",
		"projects.emptyTitle": "কোনো প্রকল্প পাওয়া যায়নি",
		"projects.emptyHint":
			"চেকআউটের projects/ ফোল্ডার দেখুন অথবা অন্য চেকআউট বেছে নিন।",
		"projects.noSearchResults": "এই অনুসন্ধানে কোনো প্রকল্প মেলেনি।",
		"projects.unavailable": "অনুপলব্ধ",
		"projects.configError": "কনফিগারেশনের সমস্যায় এই প্রকল্প খোলা যাচ্ছে না।",
		"projects.configErrorHint":
			"তালিকাভুক্ত ফাইল ও প্রকল্প সেটিং পরীক্ষা করে আবার চেকআউট বেছে নিন।",
		"projects.fileMissing": "নেই।",
		"projects.fileUnreadable": "পড়া যায়নি।",
		"projects.fileInvalid": "বিন্যাস সঠিক নয়।",
		"projects.projectIdMissing": "প্রকল্প ID নেই।",
		"projects.profileMissing": "প্রকল্প profile নেই।",
		"projects.unsafePath":
			"ফাইলটি নির্বাচিত চেকআউটের বাইরে নির্দেশ করে, তাই পড়া হয়নি।",
		"projects.selected": "নির্বাচিত",
		"projects.selectedProject": "নির্বাচিত প্রকল্প",
		"projects.tabsLabel": "প্রকল্পের দৃশ্য",
		"projects.tabCodingAgent": "কোডিং এজেন্ট",
		"projects.tabDashboard": "ড্যাশবোর্ড",
		"projects.tabInternalIssues": "অভ্যন্তরীণ সমস্যা",
		"projects.stageOneEmpty": "ধাপ ১-এর প্রাথমিক দৃশ্য। রানটাইম ও সমস্যার তথ্য সংযুক্ত নয়।",
		"projects.selectTitle": "একটি প্রকল্প বেছে নিন",
		"projects.selectHint":
			"দৃশ্য খুলতে তালিকা থেকে সঠিক কনফিগারেশনের প্রকল্প বেছে নিন।",
		"projects.projectContent": "নির্বাচিত প্রকল্পের বিষয়বস্তু",
	},
	pt: {
		"projects.title": "Projetos",
		"projects.chooseTitle": "Escolher projeto",
		"projects.checkoutLabel": "Checkout",
		"projects.chooseCheckout": "Escolher checkout",
		"projects.changeCheckout": "Alterar checkout",
		"projects.noCheckoutTitle": "Escolha um checkout do naia-pj-adk",
		"projects.noCheckoutHint":
			"Selecione o checkout que contém os projetos desejados. Nesta etapa, as telas são apenas estruturas iniciais.",
		"projects.loading": "Lendo projetos e configurações…",
		"projects.checkoutError": "Não foi possível ler este checkout",
		"projects.checkoutErrorHint":
			"Escolha um checkout naia-pj-adk com uma pasta projects/ legível e tente novamente.",
		"projects.chooseAnother": "Escolher outro checkout",
		"projects.catalogLabel": "Catálogo de projetos",
		"projects.searchLabel": "Pesquisar projetos",
		"projects.searchPlaceholder": "Pesquisar por nome, ID ou repository",
		"projects.emptyTitle": "Nenhum projeto encontrado",
		"projects.emptyHint":
			"Verifique a pasta projects/ do checkout ou escolha outro checkout.",
		"projects.noSearchResults": "Nenhum projeto corresponde à pesquisa.",
		"projects.unavailable": "Indisponível",
		"projects.configError":
			"Um problema de configuração impede abrir este projeto.",
		"projects.configErrorHint":
			"Verifique o arquivo indicado e as configurações do projeto e selecione o checkout novamente.",
		"projects.fileMissing": "está ausente.",
		"projects.fileUnreadable": "não foi possível ler.",
		"projects.fileInvalid": "tem um formato inválido.",
		"projects.projectIdMissing": "O ID do projeto está ausente.",
		"projects.profileMissing": "O profile do projeto está ausente.",
		"projects.unsafePath":
			"O arquivo aponta para fora do checkout selecionado e não foi lido.",
		"projects.selected": "Selecionado",
		"projects.selectedProject": "Projeto selecionado",
		"projects.tabsLabel": "Telas do projeto",
		"projects.tabCodingAgent": "Agente de programação",
		"projects.tabDashboard": "Painel",
		"projects.tabInternalIssues": "Problemas internos",
		"projects.stageOneEmpty":
			"Estrutura da etapa 1. O ambiente de execução e os dados de problemas não estão conectados.",
		"projects.selectTitle": "Selecione um projeto",
		"projects.selectHint":
			"Escolha na lista um projeto com configuração válida para abrir suas telas.",
		"projects.projectContent": "Conteúdo do projeto selecionado",
	},
	id: {
		"projects.title": "Proyek",
		"projects.chooseTitle": "Pilih proyek",
		"projects.checkoutLabel": "Checkout",
		"projects.chooseCheckout": "Pilih checkout",
		"projects.changeCheckout": "Ganti checkout",
		"projects.noCheckoutTitle": "Pilih checkout naia-pj-adk",
		"projects.noCheckoutHint":
			"Pilih checkout yang berisi proyek yang ingin dilihat. Tampilan proyek masih berupa kerangka pada tahap ini.",
		"projects.loading": "Membaca proyek dan konfigurasi…",
		"projects.checkoutError": "Checkout ini tidak dapat dibaca",
		"projects.checkoutErrorHint":
			"Pilih checkout naia-pj-adk dengan folder projects/ yang dapat dibaca, lalu coba lagi.",
		"projects.chooseAnother": "Pilih checkout lain",
		"projects.catalogLabel": "Katalog proyek",
		"projects.searchLabel": "Cari proyek",
		"projects.searchPlaceholder": "Cari berdasarkan nama, ID, atau repository",
		"projects.emptyTitle": "Proyek tidak ditemukan",
		"projects.emptyHint":
			"Periksa folder projects/ pada checkout atau pilih checkout lain.",
		"projects.noSearchResults": "Tidak ada proyek yang cocok dengan pencarian.",
		"projects.unavailable": "Tidak tersedia",
		"projects.configError": "Masalah konfigurasi mencegah proyek ini dibuka.",
		"projects.configErrorHint":
			"Periksa file yang tercantum dan pengaturan proyek, lalu pilih checkout lagi.",
		"projects.fileMissing": "tidak ada.",
		"projects.fileUnreadable": "tidak dapat dibaca.",
		"projects.fileInvalid": "formatnya tidak valid.",
		"projects.projectIdMissing": "ID proyek tidak ada.",
		"projects.profileMissing": "Profile proyek tidak ada.",
		"projects.unsafePath":
			"File mengarah ke luar checkout terpilih, jadi tidak dibaca.",
		"projects.selected": "Dipilih",
		"projects.selectedProject": "Proyek terpilih",
		"projects.tabsLabel": "Tampilan proyek",
		"projects.tabCodingAgent": "Agen pengodean",
		"projects.tabDashboard": "Dasbor",
		"projects.tabInternalIssues": "Masalah internal",
		"projects.stageOneEmpty":
			"Kerangka tahap 1. Runtime dan data masalah belum terhubung.",
		"projects.selectTitle": "Pilih proyek",
		"projects.selectHint":
			"Pilih proyek dengan konfigurasi valid dari daftar untuk membuka tampilannya.",
		"projects.projectContent": "Konten proyek terpilih",
	},
	vi: {
		"projects.title": "Dự án",
		"projects.chooseTitle": "Chọn dự án",
		"projects.checkoutLabel": "Bản checkout",
		"projects.chooseCheckout": "Chọn checkout",
		"projects.changeCheckout": "Đổi checkout",
		"projects.noCheckoutTitle": "Chọn checkout naia-pj-adk",
		"projects.noCheckoutHint":
			"Chọn checkout chứa các dự án bạn muốn xem. Ở giai đoạn này, các màn hình chỉ là khung ban đầu.",
		"projects.loading": "Đang đọc dự án và cấu hình…",
		"projects.checkoutError": "Không thể đọc checkout này",
		"projects.checkoutErrorHint":
			"Chọn checkout naia-pj-adk có thư mục projects/ đọc được rồi thử lại.",
		"projects.chooseAnother": "Chọn checkout khác",
		"projects.catalogLabel": "Danh mục dự án",
		"projects.searchLabel": "Tìm dự án",
		"projects.searchPlaceholder": "Tìm theo tên, ID hoặc repository",
		"projects.emptyTitle": "Không tìm thấy dự án",
		"projects.emptyHint": "Kiểm tra thư mục projects/ hoặc chọn checkout khác.",
		"projects.noSearchResults": "Không có dự án phù hợp với tìm kiếm.",
		"projects.unavailable": "Không khả dụng",
		"projects.configError": "Lỗi cấu hình khiến không thể mở dự án này.",
		"projects.configErrorHint":
			"Kiểm tra tệp được liệt kê và cấu hình dự án, sau đó chọn lại checkout.",
		"projects.fileMissing": "bị thiếu.",
		"projects.fileUnreadable": "không thể đọc được.",
		"projects.fileInvalid": "có định dạng không hợp lệ.",
		"projects.projectIdMissing": "Thiếu ID dự án.",
		"projects.profileMissing": "Thiếu profile của dự án.",
		"projects.unsafePath": "Tệp nằm ngoài checkout đã chọn nên không được đọc.",
		"projects.selected": "Đã chọn",
		"projects.selectedProject": "Dự án đã chọn",
		"projects.tabsLabel": "Màn hình dự án",
		"projects.tabCodingAgent": "Tác nhân lập trình",
		"projects.tabDashboard": "Bảng điều khiển",
		"projects.tabInternalIssues": "Vấn đề nội bộ",
		"projects.stageOneEmpty":
			"Khung của giai đoạn 1. Runtime và dữ liệu vấn đề chưa được kết nối.",
		"projects.selectTitle": "Chọn một dự án",
		"projects.selectHint":
			"Chọn dự án có cấu hình hợp lệ trong danh sách để mở các màn hình.",
		"projects.projectContent": "Nội dung dự án đã chọn",
	},
};

export type { ProjectTranslationKey };

export function projectText(
	key: ProjectTranslationKey,
	params?: Readonly<Record<string, string | number>>,
): string {
	const value = PROJECT_APP_TRANSLATIONS[getLocale()][key];
	if (!params) return value;
	return value.replace(/\{(\w+)\}/g, (whole, name) =>
		Object.prototype.hasOwnProperty.call(params, name)
			? String(params[name])
			: whole,
	);
}
