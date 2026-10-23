import type { Locale } from "../../../lib/i18n";
import { Logger } from "../../../lib/logger";
import { PROJECT_AGENT_ENGLISH_TRANSLATIONS } from "./project-agent";

Logger.debug("ProjectsLocale", "loading project catalog and session locale strings");

export const PROJECT_APP_NAMES: Partial<Record<Locale, string>> = {
	ko: "프로젝트",
};

export const PROJECT_BASE_ENGLISH_TRANSLATIONS = {
	...PROJECT_AGENT_ENGLISH_TRANSLATIONS,
	"projects.title": "Projects",
	"projects.chooseTitle": "Choose a project",
	"projects.checkoutLabel": "Source",
	"projects.chooseCheckout": "Choose naia-adk folder",
	"projects.changeCheckout": "Open another project",
	"projects.noCheckoutTitle": "Choose your naia-adk folder",
	"projects.noCheckoutHint":
		"Select the naia-adk folder to browse its projects. The app reads project metadata only. If the saved folder no longer works, choose it again or use Settings > naia-adk path reset.",
	"projects.loading": "Reading projects from naia-adk…",
	"projects.checkoutError": "Could not read the naia-adk projects",
	"projects.checkoutErrorHint":
		"Choose a naia-adk folder containing a readable projects/ directory. You can recover the saved path in Settings > naia-adk path reset.",
	"projects.chooseAnother": "Choose folder again",
	"projects.catalogLabel": "Project catalog",
	"projects.searchLabel": "Search projects",
	"projects.searchPlaceholder": "Search by name, ID, repository, or source",
	"projects.emptyTitle": "No projects found",
	"projects.emptyHint":
		"Check naia-adk/projects for projects/<project>/project.yaml files with a nested, non-empty project.id. To use another naia-adk folder, reset its path in Settings.",
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
	"projects.unsafePath":
		"The path points outside the naia-adk folder and was not read.",
	"projects.selected": "Selected",
	"projects.selectedProject": "Selected project",
	"projects.tabsLabel": "Project views",
	"projects.tabCodingAgent": "Coding Agent",
	"projects.tabDashboard": "Dashboard",
	"projects.tabInternalIssues": "Internal Issues",
	"projects.stageOneEmpty":
		"This view is a placeholder in stage 2. The coding agent, dashboard, and internal issue data are not connected yet.",
	"projects.selectTitle": "Select a project",
	"projects.selectHint":
		"Choose a ready project from the list to open its views.",
	"projects.projectContent": "Selected project content",
	"projects.scanLimitedTitle": "Some project details were skipped",
	"projects.scanEntryLimit":
		"Scanned {scanned} of {limit} directory entries under naia-adk/projects; more entries remain.",
	"projects.scanRowLimit":
		"Showing {shown} of {limit} project and error rows. More rows were found.",
	"projects.scanFileLimit":
		"{count} configuration files exceeded the {limit}-byte limit and were not parsed.",
	"projects.scanFileObservedBytes": "File size: {bytes} bytes.",
	"projects.scanMoreFiles": "{count} additional files were skipped.",
	"projects.fileTooLarge": "exceeds the 64 KiB metadata limit.",
	"projects.catalogErrors": "Catalog entries with problems",
	"projects.returnToCurrentProject": "Back to {name}",
	"projects.lastProjectMissing":
		"The last project is no longer in the catalog. Choose a project to continue.",
	"projects.sessionInvalid":
		"Saved project state could not be read. Choose a project to continue.",
	"projects.sessionSaveFailed":
		"Project state could not be saved. Changes may be lost when the shell restarts.",
} as const;

export type ProjectTranslationKey = keyof typeof PROJECT_BASE_ENGLISH_TRANSLATIONS;

export const LEGACY_TRANSLATIONS: Record<
	Locale,
	Partial<Record<ProjectTranslationKey, string>>
> = {
	en: PROJECT_BASE_ENGLISH_TRANSLATIONS,
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
		"projects.scanLimitedTitle": "프로젝트 일부를 읽지 않았습니다",
		"projects.scanEntryLimit":
			"프로젝트 항목 {scanned}개를 확인했습니다. {limit}개 제한 이후에도 항목이 더 있어 나머지는 표시되지 않습니다. 나머지를 보려면 더 작은 체크아웃을 선택하세요.",
		"projects.scanFileLimit":
			"설정 파일 {count}개가 {limit}바이트 읽기 제한을 넘어 파싱하지 않았습니다.",
		"projects.scanFileObservedBytes": "{bytes}바이트를 읽은 뒤 중단했습니다.",
		"projects.scanMoreFiles": "그 밖에 {count}개 파일도 읽지 않았습니다.",
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
		"projects.scanLimitedTitle": "一部のプロジェクト情報を読み取りませんでした",
		"projects.scanEntryLimit":
			"{scanned} 件の項目を確認しました。上限の {limit} 件を超える項目があります。残りを見るには小さいチェックアウトを選択してください。",
		"projects.scanFileLimit":
			"設定ファイル {count} 件は {limit} バイトの読み取り上限を超えたため解析しませんでした。",
		"projects.scanFileObservedBytes":
			"{bytes} バイトを読み取った時点で停止しました。",
		"projects.scanMoreFiles":
			"ほかに {count} 件のファイルを読み取りませんでした。",
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
		"projects.scanLimitedTitle": "部分项目资料未读取",
		"projects.scanEntryLimit":
			"已检查 {scanned} 个项目条目。超过 {limit} 个条目后仍有更多内容。请选择较小的检出目录以查看其余项目。",
		"projects.scanFileLimit":
			"{count} 个配置文件超过 {limit} 字节读取上限，因此未解析。",
		"projects.scanFileObservedBytes": "读取 {bytes} 字节后停止。",
		"projects.scanMoreFiles": "另有 {count} 个文件未读取。",
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
		"projects.scanLimitedTitle":
			"Certaines informations de projet n’ont pas été lues",
		"projects.scanEntryLimit":
			"{scanned} entrées sur {limit} ont été parcourues ; d’autres entrées existent. Choisissez un checkout plus petit pour voir la suite.",
		"projects.scanFileLimit":
			"{count} fichiers de configuration dépassent la limite de lecture de {limit} octets et n’ont pas été analysés.",
		"projects.scanFileObservedBytes":
			"La lecture s’est arrêtée après {bytes} octets.",
		"projects.scanMoreFiles": "{count} autres fichiers n’ont pas été lus.",
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
		"projects.scanLimitedTitle": "Einige Projektdaten wurden übersprungen",
		"projects.scanEntryLimit":
			"{scanned} von {limit} Projektelementen wurden geprüft; weitere Elemente sind vorhanden. Wähle einen kleineren Checkout, um den Rest zu sehen.",
		"projects.scanFileLimit":
			"{count} Konfigurationsdateien überschritten das Leselimit von {limit} Bytes und wurden nicht ausgewertet.",
		"projects.scanFileObservedBytes":
			"Das Lesen wurde nach {bytes} Bytes beendet.",
		"projects.scanMoreFiles": "{count} weitere Dateien wurden übersprungen.",
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
		"projects.scanLimitedTitle": "Часть данных проектов не прочитана",
		"projects.scanEntryLimit":
			"Проверено элементов проектов: {scanned} из {limit}; есть и другие. Выберите меньший checkout, чтобы увидеть остальные проекты.",
		"projects.scanFileLimit":
			"Файлы конфигурации ({count}) превысили лимит чтения {limit} байт и не были разобраны.",
		"projects.scanFileObservedBytes": "Чтение остановлено после {bytes} байт.",
		"projects.scanMoreFiles": "Не прочитано ещё файлов: {count}.",
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
		"projects.scanLimitedTitle": "Se omitieron algunos datos de proyectos",
		"projects.scanEntryLimit":
			"Se revisaron {scanned} de {limit} entradas; hay más. Elige un checkout más pequeño para ver el resto.",
		"projects.scanFileLimit":
			"{count} archivos de configuración superaron el límite de lectura de {limit} bytes y no se analizaron.",
		"projects.scanFileObservedBytes":
			"La lectura se detuvo después de {bytes} bytes.",
		"projects.scanMoreFiles": "Se omitieron {count} archivos más.",
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
		"projects.scanLimitedTitle": "تم تخطي بعض بيانات المشاريع",
		"projects.scanEntryLimit":
			"تم فحص {scanned} من أصل {limit} عنصرًا، وما زالت هناك عناصر أخرى. اختر checkout أصغر لعرض البقية.",
		"projects.scanFileLimit":
			"تجاوزت ملفات الإعداد ({count}) حد القراءة البالغ {limit} بايت، لذلك لم يتم تحليلها.",
		"projects.scanFileObservedBytes": "توقفَت القراءة بعد {bytes} بايت.",
		"projects.scanMoreFiles": "تم تخطي {count} ملفات إضافية.",
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
		"projects.scanLimitedTitle": "कुछ प्रोजेक्ट विवरण नहीं पढ़े गए",
		"projects.scanEntryLimit":
			"{limit} में से {scanned} प्रोजेक्ट प्रविष्टियाँ जाँची गईं; और प्रविष्टियाँ मौजूद हैं। बाकी देखने के लिए छोटा checkout चुनें।",
		"projects.scanFileLimit":
			"{count} कॉन्फ़िगरेशन फ़ाइलें {limit}-बाइट पढ़ने की सीमा से बड़ी थीं और पार्स नहीं की गईं।",
		"projects.scanFileObservedBytes": "{bytes} बाइट पढ़ने के बाद रुक गया।",
		"projects.scanMoreFiles": "{count} अतिरिक्त फ़ाइलें भी नहीं पढ़ी गईं।",
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
		"projects.scanLimitedTitle": "কিছু প্রকল্পের তথ্য পড়া হয়নি",
		"projects.scanEntryLimit":
			"{limit}টির মধ্যে {scanned}টি প্রকল্প এন্ট্রি পরীক্ষা করা হয়েছে; আরও এন্ট্রি রয়েছে। বাকি দেখতে ছোট checkout বেছে নিন।",
		"projects.scanFileLimit":
			"{count}টি কনফিগারেশন ফাইল {limit}-বাইট পড়ার সীমা ছাড়িয়েছে, তাই সেগুলো পার্স করা হয়নি।",
		"projects.scanFileObservedBytes": "{bytes} বাইট পড়ার পর থামানো হয়েছে।",
		"projects.scanMoreFiles": "আরও {count}টি ফাইল পড়া হয়নি।",
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
		"projects.scanLimitedTitle": "Alguns dados do projeto foram ignorados",
		"projects.scanEntryLimit":
			"{scanned} de {limit} entradas foram verificadas; há mais entradas. Escolha um checkout menor para ver o restante.",
		"projects.scanFileLimit":
			"{count} arquivos de configuração excederam o limite de leitura de {limit} bytes e não foram analisados.",
		"projects.scanFileObservedBytes": "A leitura parou após {bytes} bytes.",
		"projects.scanMoreFiles": "{count} arquivos adicionais foram ignorados.",
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
		"projects.scanLimitedTitle": "Sebagian data proyek tidak dibaca",
		"projects.scanEntryLimit":
			"{scanned} dari {limit} entri proyek telah diperiksa; masih ada entri lain. Pilih checkout yang lebih kecil untuk melihat sisanya.",
		"projects.scanFileLimit":
			"{count} file konfigurasi melebihi batas baca {limit} byte dan tidak diuraikan.",
		"projects.scanFileObservedBytes":
			"Pembacaan berhenti setelah {bytes} byte.",
		"projects.scanMoreFiles": "{count} file tambahan juga dilewati.",
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
		"projects.scanLimitedTitle": "Một phần thông tin dự án chưa được đọc",
		"projects.scanEntryLimit":
			"Đã kiểm tra {scanned}/{limit} mục dự án và vẫn còn mục khác. Hãy chọn checkout nhỏ hơn để xem phần còn lại.",
		"projects.scanFileLimit":
			"{count} tệp cấu hình vượt giới hạn đọc {limit} byte nên chưa được phân tích.",
		"projects.scanFileObservedBytes": "Đã dừng đọc sau {bytes} byte.",
		"projects.scanMoreFiles": "Còn {count} tệp khác chưa được đọc.",
	},
};

export const STAGE_TWO_TRANSLATIONS: Record<
	Locale,
	Partial<Record<ProjectTranslationKey, string>>
> = {
	en: {},
	ko: {
		"projects.checkoutLabel": "출처",
		"projects.chooseCheckout": "naia-adk 폴더 선택",
		"projects.changeCheckout": "다른 프로젝트 열기",
		"projects.noCheckoutTitle": "naia-adk 폴더를 선택하세요",
		"projects.noCheckoutHint":
			"프로젝트를 찾을 naia-adk 폴더를 선택하세요. 저장한 폴더를 읽을 수 없으면 다시 선택하거나 설정 > naia-adk 경로 재설정에서 복구할 수 있습니다.",
		"projects.loading": "naia-adk에서 프로젝트를 읽는 중…",
		"projects.checkoutError": "naia-adk 프로젝트를 읽지 못했습니다",
		"projects.checkoutErrorHint":
			"projects/ 폴더가 있는 naia-adk를 선택하세요. 저장된 경로는 설정 > naia-adk 경로 재설정에서 복구할 수 있습니다.",
		"projects.chooseAnother": "폴더 다시 선택",
		"projects.searchPlaceholder": "이름, ID, 저장소, 출처로 검색",
		"projects.emptyHint":
			"naia-adk/projects에서 중첩 project.id가 비어 있지 않은 projects/<프로젝트>/project.yaml을 확인하세요. 다른 naia-adk를 사용하려면 설정에서 경로를 재설정하세요.",
		"projects.unsafePath": "naia-adk 폴더 바깥의 경로라 읽지 않았습니다.",
		"projects.stageOneEmpty":
			"2단계에서는 빈 화면으로 둡니다. 코딩 에이전트·대시보드·내부 이슈 데이터는 아직 연결하지 않았습니다.",
		"projects.scanEntryLimit":
			"naia-adk/projects 아래 항목 {scanned}/{limit}개를 읽었습니다. 더 많은 항목이 있어 일부는 표시되지 않습니다.",
		"projects.scanRowLimit":
			"프로젝트와 오류 {shown}/{limit}개를 표시했습니다. 더 많은 행이 있습니다.",
		"projects.scanFileObservedBytes": "파일 크기: {bytes}바이트.",
		"projects.fileTooLarge": "메타데이터 64KiB 제한을 초과했습니다.",
		"projects.catalogErrors": "확인이 필요한 카탈로그 항목",
		"projects.returnToCurrentProject": "{name}(으)로 돌아가기",
		"projects.lastProjectMissing":
			"마지막으로 연 프로젝트가 목록에 없습니다. 프로젝트를 선택하세요.",
		"projects.sessionInvalid":
			"저장된 프로젝트 상태를 읽지 못했습니다. 프로젝트를 선택하세요.",
	},
	ja: {
		"projects.checkoutLabel": "場所",
		"projects.chooseCheckout": "naia-adk フォルダーを選択",
		"projects.changeCheckout": "別のプロジェクトを開く",
		"projects.noCheckoutTitle": "naia-adk フォルダーを選択",
		"projects.noCheckoutHint":
			"プロジェクトを探す naia-adk フォルダーを選択してください。保存先が読めない場合は再選択するか、設定からパスをリセットしてください。",
		"projects.loading": "naia-adk のプロジェクトを読み込み中…",
		"projects.checkoutError": "naia-adk のプロジェクトを読み込めません",
		"projects.checkoutErrorHint":
			"projects/ を含む naia-adk を選択してください。保存先は設定からリセットできます。",
		"projects.chooseAnother": "フォルダーを再選択",
		"projects.searchPlaceholder": "名前、ID、repository、場所で検索",
		"projects.emptyHint":
			"naia-adk/projects で、空でない入れ子の project.id を持つ projects/<project>/project.yaml を確認してください。別の naia-adk を使うには設定でパスをリセットしてください。",
		"projects.unsafePath":
			"naia-adk フォルダー外のパスのため読み込みませんでした。",
		"projects.stageOneEmpty":
			"ステージ 2 のプレースホルダーです。コーディングエージェント、ダッシュボード、内部 Issue は未接続です。",
		"projects.scanEntryLimit":
			"naia-adk/projects の {scanned}/{limit} 件を確認しました。ほかにも項目があります。",
		"projects.scanRowLimit":
			"プロジェクトとエラーを {shown}/{limit} 件表示しています。さらに行があります。",
		"projects.scanFileObservedBytes": "ファイルサイズ: {bytes} バイト。",
		"projects.fileTooLarge": "メタデータの 64 KiB 上限を超えています。",
		"projects.catalogErrors": "確認が必要なカタログ項目",
		"projects.returnToCurrentProject": "{name} に戻る",
		"projects.lastProjectMissing":
			"最後に開いたプロジェクトは一覧にありません。プロジェクトを選択してください。",
		"projects.sessionInvalid":
			"保存したプロジェクト状態を読み込めません。プロジェクトを選択してください。",
	},
	zh: {
		"projects.checkoutLabel": "来源",
		"projects.chooseCheckout": "选择 naia-adk 文件夹",
		"projects.changeCheckout": "打开其他项目",
		"projects.noCheckoutTitle": "选择 naia-adk 文件夹",
		"projects.noCheckoutHint":
			"选择用于查找项目的 naia-adk 文件夹。保存位置无法读取时，请重新选择或在设置中重置路径。",
		"projects.loading": "正在读取 naia-adk 项目…",
		"projects.checkoutError": "无法读取 naia-adk 项目",
		"projects.checkoutErrorHint":
			"请选择包含 projects/ 的 naia-adk。可在设置中重置保存的路径。",
		"projects.chooseAnother": "重新选择文件夹",
		"projects.searchPlaceholder": "按名称、ID、仓库或来源搜索",
		"projects.emptyHint":
			"请检查 naia-adk/projects 中 projects/<project>/project.yaml 是否包含非空的嵌套 project.id。要使用其他 naia-adk 文件夹，请在设置中重置路径。",
		"projects.unsafePath": "路径位于 naia-adk 文件夹之外，因此未读取。",
		"projects.stageOneEmpty":
			"这是阶段 2 的占位视图。编码代理、仪表板和内部问题数据尚未连接。",
		"projects.scanEntryLimit":
			"已检查 naia-adk/projects 中 {scanned}/{limit} 个条目，仍有更多条目。",
		"projects.scanRowLimit":
			"已显示 {shown}/{limit} 个项目和错误条目，仍有更多行。",
		"projects.scanFileObservedBytes": "文件大小：{bytes} 字节。",
		"projects.fileTooLarge": "超过了 64 KiB 元数据限制。",
		"projects.catalogErrors": "需要检查的目录条目",
		"projects.returnToCurrentProject": "返回 {name}",
		"projects.lastProjectMissing": "上次打开的项目不在目录中。请选择一个项目。",
		"projects.sessionInvalid": "无法读取已保存的项目状态。请选择一个项目。",
	},
	fr: {
		"projects.checkoutLabel": "Source",
		"projects.chooseCheckout": "Choisir le dossier naia-adk",
		"projects.changeCheckout": "Ouvrir un autre projet",
		"projects.noCheckoutTitle": "Choisissez votre dossier naia-adk",
		"projects.noCheckoutHint":
			"Choisissez le dossier naia-adk contenant les projets. Si le dossier enregistré est inaccessible, choisissez-le à nouveau ou réinitialisez son chemin dans les paramètres.",
		"projects.loading": "Lecture des projets de naia-adk…",
		"projects.checkoutError": "Impossible de lire les projets naia-adk",
		"projects.checkoutErrorHint":
			"Choisissez un dossier naia-adk contenant projects/. Le chemin enregistré peut être réinitialisé dans les paramètres.",
		"projects.chooseAnother": "Choisir à nouveau le dossier",
		"projects.searchPlaceholder": "Rechercher par nom, ID, dépôt ou source",
		"projects.emptyHint":
			"Vérifiez dans naia-adk/projects les fichiers projects/<project>/project.yaml avec un project.id imbriqué non vide. Pour utiliser un autre dossier naia-adk, réinitialisez son chemin dans les paramètres.",
		"projects.unsafePath":
			"Le chemin sort du dossier naia-adk et n’a pas été lu.",
		"projects.stageOneEmpty":
			"Espace réservé de l’étape 2. L’agent de code, le tableau de bord et les incidents internes ne sont pas connectés.",
		"projects.scanEntryLimit":
			"{scanned}/{limit} entrées parcourues dans naia-adk/projects ; d’autres entrées existent.",
		"projects.scanRowLimit":
			"{shown}/{limit} projets et erreurs affichés ; d’autres lignes existent.",
		"projects.scanFileObservedBytes": "Taille du fichier : {bytes} octets.",
		"projects.fileTooLarge": "Dépasse la limite de métadonnées de 64 Kio.",
		"projects.catalogErrors": "Éléments du catalogue à vérifier",
		"projects.returnToCurrentProject": "Retour à {name}",
		"projects.lastProjectMissing":
			"Le dernier projet ouvert est absent du catalogue. Choisissez un projet.",
		"projects.sessionInvalid":
			"L’état enregistré du projet est illisible. Choisissez un projet.",
	},
	de: {
		"projects.checkoutLabel": "Quelle",
		"projects.chooseCheckout": "naia-adk-Ordner auswählen",
		"projects.changeCheckout": "Anderes Projekt öffnen",
		"projects.noCheckoutTitle": "Wähle deinen naia-adk-Ordner",
		"projects.noCheckoutHint":
			"Wähle den naia-adk-Ordner mit den Projekten. Wenn der gespeicherte Ordner nicht lesbar ist, wähle ihn erneut oder setze den Pfad in den Einstellungen zurück.",
		"projects.loading": "Projekte aus naia-adk werden gelesen…",
		"projects.checkoutError": "naia-adk-Projekte konnten nicht gelesen werden",
		"projects.checkoutErrorHint":
			"Wähle einen naia-adk-Ordner mit projects/. Den gespeicherten Pfad kannst du in den Einstellungen zurücksetzen.",
		"projects.chooseAnother": "Ordner erneut wählen",
		"projects.searchPlaceholder":
			"Nach Name, ID, Repository oder Quelle suchen",
		"projects.emptyHint":
			"Prüfe in naia-adk/projects die Dateien projects/<project>/project.yaml auf eine nicht leere, verschachtelte project.id-Angabe. Um einen anderen naia-adk-Ordner zu verwenden, setze den Pfad in den Einstellungen zurück.",
		"projects.unsafePath":
			"Der Pfad liegt außerhalb des naia-adk-Ordners und wurde nicht gelesen.",
		"projects.stageOneEmpty":
			"Platzhalter in Stufe 2. Programmieragent, Dashboard und interne Issues sind noch nicht verbunden.",
		"projects.scanEntryLimit":
			"{scanned} von {limit} Einträgen unter naia-adk/projects geprüft; weitere Einträge sind vorhanden.",
		"projects.scanRowLimit":
			"{shown} von {limit} Projekt- und Fehlerzeilen angezeigt; weitere Zeilen sind vorhanden.",
		"projects.scanFileObservedBytes": "Dateigröße: {bytes} Bytes.",
		"projects.fileTooLarge": "Überschreitet das Metadatenlimit von 64 KiB.",
		"projects.catalogErrors": "Katalogeinträge mit Problemen",
		"projects.returnToCurrentProject": "Zurück zu {name}",
		"projects.lastProjectMissing":
			"Das zuletzt geöffnete Projekt ist nicht mehr im Katalog. Wähle ein Projekt.",
		"projects.sessionInvalid":
			"Der gespeicherte Projektstatus ist ungültig. Wähle ein Projekt.",
	},
	ru: {
		"projects.checkoutLabel": "Источник",
		"projects.chooseCheckout": "Выбрать папку naia-adk",
		"projects.changeCheckout": "Открыть другой проект",
		"projects.noCheckoutTitle": "Выберите папку naia-adk",
		"projects.noCheckoutHint":
			"Выберите папку naia-adk с проектами. Если сохранённая папка недоступна, выберите её снова или сбросьте путь в настройках.",
		"projects.loading": "Чтение проектов из naia-adk…",
		"projects.checkoutError": "Не удалось прочитать проекты naia-adk",
		"projects.checkoutErrorHint":
			"Выберите naia-adk с доступной папкой projects/. Сохранённый путь можно сбросить в настройках.",
		"projects.chooseAnother": "Выбрать папку снова",
		"projects.searchPlaceholder":
			"Поиск по имени, ID, репозиторию или источнику",
		"projects.emptyHint":
			"Проверьте в naia-adk/projects файлы projects/<project>/project.yaml с непустым вложенным project.id. Чтобы использовать другую папку naia-adk, сбросьте путь в настройках.",
		"projects.unsafePath":
			"Путь выходит за пределы naia-adk, поэтому файл не прочитан.",
		"projects.stageOneEmpty":
			"Заглушка этапа 2. Кодовый агент, панель и внутренние задачи ещё не подключены.",
		"projects.scanEntryLimit":
			"Проверено {scanned} из {limit} записей в naia-adk/projects; есть и другие.",
		"projects.scanRowLimit":
			"Показано {shown} из {limit} строк проектов и ошибок; есть ещё строки.",
		"projects.scanFileObservedBytes": "Размер файла: {bytes} байт.",
		"projects.fileTooLarge": "Превышен лимит метаданных 64 КиБ.",
		"projects.catalogErrors": "Проблемные записи каталога",
		"projects.returnToCurrentProject": "Вернуться к {name}",
		"projects.lastProjectMissing":
			"Последнего открытого проекта нет в каталоге. Выберите проект.",
		"projects.sessionInvalid":
			"Не удалось прочитать сохранённое состояние. Выберите проект.",
	},
	es: {
		"projects.checkoutLabel": "Origen",
		"projects.chooseCheckout": "Elegir carpeta naia-adk",
		"projects.changeCheckout": "Abrir otro proyecto",
		"projects.noCheckoutTitle": "Elige tu carpeta naia-adk",
		"projects.noCheckoutHint":
			"Elige la carpeta naia-adk con los proyectos. Si la carpeta guardada no se puede leer, vuelve a elegirla o restablece la ruta en Configuración.",
		"projects.loading": "Leyendo proyectos de naia-adk…",
		"projects.checkoutError": "No se pudieron leer los proyectos de naia-adk",
		"projects.checkoutErrorHint":
			"Elige una carpeta naia-adk que contenga projects/. Puedes restablecer la ruta guardada en Configuración.",
		"projects.chooseAnother": "Elegir carpeta de nuevo",
		"projects.searchPlaceholder": "Buscar por nombre, ID, repositorio u origen",
		"projects.emptyHint":
			"Revisa en naia-adk/projects los archivos projects/<project>/project.yaml con un project.id anidado y no vacío. Para usar otra carpeta naia-adk, restablece la ruta en Configuración.",
		"projects.unsafePath": "La ruta está fuera de naia-adk y no se leyó.",
		"projects.stageOneEmpty":
			"Marcador de la etapa 2. El agente de código, el panel y los asuntos internos aún no están conectados.",
		"projects.scanEntryLimit":
			"Se revisaron {scanned} de {limit} entradas en naia-adk/projects; hay más.",
		"projects.scanRowLimit":
			"Se muestran {shown} de {limit} filas de proyectos y errores; hay más filas.",
		"projects.scanFileObservedBytes": "Tamaño del archivo: {bytes} bytes.",
		"projects.fileTooLarge": "Supera el límite de metadatos de 64 KiB.",
		"projects.catalogErrors": "Entradas del catálogo con problemas",
		"projects.returnToCurrentProject": "Volver a {name}",
		"projects.lastProjectMissing":
			"El último proyecto abierto ya no está en el catálogo. Elige un proyecto.",
		"projects.sessionInvalid":
			"No se pudo leer el estado guardado del proyecto. Elige un proyecto.",
	},
	ar: {
		"projects.checkoutLabel": "المصدر",
		"projects.chooseCheckout": "اختر مجلد naia-adk",
		"projects.changeCheckout": "افتح مشروعًا آخر",
		"projects.noCheckoutTitle": "اختر مجلد naia-adk",
		"projects.noCheckoutHint":
			"اختر مجلد naia-adk الذي يحتوي على المشاريع. إذا تعذرت قراءة المجلد المحفوظ، فاختره مجددًا أو أعد ضبط المسار من الإعدادات.",
		"projects.loading": "جارٍ قراءة مشاريع naia-adk…",
		"projects.checkoutError": "تعذرت قراءة مشاريع naia-adk",
		"projects.checkoutErrorHint":
			"اختر مجلد naia-adk يحتوي على projects/. يمكنك إعادة ضبط المسار المحفوظ من الإعدادات.",
		"projects.chooseAnother": "اختر المجلد مجددًا",
		"projects.searchPlaceholder": "ابحث بالاسم أو المعرّف أو المستودع أو المصدر",
		"projects.emptyHint":
			"تحقق في naia-adk/projects من ملفات projects/<project>/project.yaml التي تحتوي على project.id متداخل غير فارغ. لاستخدام مجلد naia-adk آخر، أعد تعيين المسار من الإعدادات.",
		"projects.unsafePath": "المسار خارج مجلد naia-adk، لذلك لم تتم قراءته.",
		"projects.stageOneEmpty":
			"عنصر نائب للمرحلة 2. لم يتم ربط وكيل البرمجة ولوحة المعلومات والمشكلات الداخلية بعد.",
		"projects.scanEntryLimit":
			"تم فحص {scanned} من {limit} مدخلات في naia-adk/projects؛ توجد مدخلات أخرى.",
		"projects.scanRowLimit":
			"يتم عرض {shown} من {limit} صفوف المشاريع والأخطاء؛ توجد صفوف أخرى.",
		"projects.scanFileObservedBytes": "حجم الملف: {bytes} بايت.",
		"projects.fileTooLarge": "يتجاوز حد بيانات التعريف 64 كيلوبايت.",
		"projects.catalogErrors": "مدخلات الكتالوج التي تحتاج إلى مراجعة",
		"projects.returnToCurrentProject": "العودة إلى {name}",
		"projects.lastProjectMissing":
			"المشروع الأخير غير موجود في الكتالوج. اختر مشروعًا للمتابعة.",
		"projects.sessionInvalid":
			"تعذرت قراءة حالة المشروع المحفوظة. اختر مشروعًا للمتابعة.",
	},
	hi: {
		"projects.checkoutLabel": "स्रोत",
		"projects.chooseCheckout": "naia-adk फ़ोल्डर चुनें",
		"projects.changeCheckout": "दूसरा प्रोजेक्ट खोलें",
		"projects.noCheckoutTitle": "अपना naia-adk फ़ोल्डर चुनें",
		"projects.noCheckoutHint":
			"प्रोजेक्ट खोजने के लिए naia-adk फ़ोल्डर चुनें। सहेजा गया फ़ोल्डर न पढ़ा जाए तो उसे फिर चुनें या सेटिंग में पथ रीसेट करें।",
		"projects.loading": "naia-adk से प्रोजेक्ट पढ़े जा रहे हैं…",
		"projects.checkoutError": "naia-adk प्रोजेक्ट नहीं पढ़े जा सके",
		"projects.checkoutErrorHint":
			"projects/ वाला naia-adk फ़ोल्डर चुनें। सहेजा गया पथ सेटिंग में रीसेट किया जा सकता है।",
		"projects.chooseAnother": "फ़ोल्डर फिर चुनें",
		"projects.searchPlaceholder": "नाम, ID, repository या स्रोत से खोजें",
		"projects.emptyHint":
			"naia-adk/projects में ऐसे projects/<project>/project.yaml देखें जिनमें nested project.id खाली न हो। दूसरा naia-adk फ़ोल्डर इस्तेमाल करने के लिए सेटिंग में उसका पथ रीसेट करें।",
		"projects.unsafePath": "पथ naia-adk फ़ोल्डर के बाहर है, इसलिए इसे नहीं पढ़ा गया।",
		"projects.stageOneEmpty":
			"चरण 2 का अस्थायी दृश्य। कोडिंग एजेंट, डैशबोर्ड और आंतरिक मुद्दे अभी जुड़े नहीं हैं।",
		"projects.scanEntryLimit":
			"naia-adk/projects में {scanned}/{limit} प्रविष्टियाँ जाँची गईं; और प्रविष्टियाँ हैं।",
		"projects.scanRowLimit":
			"{shown}/{limit} प्रोजेक्ट और त्रुटि पंक्तियाँ दिखाई गईं; और पंक्तियाँ हैं।",
		"projects.scanFileObservedBytes": "फ़ाइल का आकार: {bytes} बाइट।",
		"projects.fileTooLarge": "64 KiB मेटाडेटा सीमा से बड़ा है।",
		"projects.catalogErrors": "जाँचने के लिए कैटलॉग प्रविष्टियाँ",
		"projects.returnToCurrentProject": "{name} पर लौटें",
		"projects.lastProjectMissing":
			"आख़िरी प्रोजेक्ट कैटलॉग में नहीं है। जारी रखने के लिए प्रोजेक्ट चुनें।",
		"projects.sessionInvalid":
			"सहेजी गई प्रोजेक्ट स्थिति पढ़ी नहीं जा सकी। प्रोजेक्ट चुनें।",
	},
	bn: {
		"projects.checkoutLabel": "উৎস",
		"projects.chooseCheckout": "naia-adk ফোল্ডার বেছে নিন",
		"projects.changeCheckout": "অন্য প্রকল্প খুলুন",
		"projects.noCheckoutTitle": "আপনার naia-adk ফোল্ডার বেছে নিন",
		"projects.noCheckoutHint":
			"প্রকল্প খুঁজতে naia-adk ফোল্ডার বেছে নিন। সংরক্ষিত ফোল্ডার পড়া না গেলে আবার বেছে নিন বা সেটিংসে পথ রিসেট করুন।",
		"projects.loading": "naia-adk থেকে প্রকল্প পড়া হচ্ছে…",
		"projects.checkoutError": "naia-adk প্রকল্প পড়া যায়নি",
		"projects.checkoutErrorHint":
			"projects/ থাকা naia-adk ফোল্ডার বেছে নিন। সেটিংসে সংরক্ষিত পথ রিসেট করা যাবে।",
		"projects.chooseAnother": "ফোল্ডার আবার বেছে নিন",
		"projects.searchPlaceholder": "নাম, ID, repository বা উৎস দিয়ে খুঁজুন",
		"projects.emptyHint":
			"naia-adk/projects-এ projects/<project>/project.yaml দেখুন, যেখানে nested project.id খালি নয়। অন্য naia-adk ফোল্ডার ব্যবহার করতে সেটিংসে পথ রিসেট করুন।",
		"projects.unsafePath": "পথটি naia-adk ফোল্ডারের বাইরে, তাই পড়া হয়নি।",
		"projects.stageOneEmpty":
			"ধাপ ২-এর খালি দৃশ্য। কোডিং এজেন্ট, ড্যাশবোর্ড ও অভ্যন্তরীণ ইস্যু এখনো যুক্ত নয়।",
		"projects.scanEntryLimit":
			"naia-adk/projects-এর {scanned}/{limit}টি এন্ট্রি দেখা হয়েছে; আরও আছে।",
		"projects.scanRowLimit":
			"{shown}/{limit}টি প্রকল্প ও ত্রুটি সারি দেখানো হয়েছে; আরও সারি আছে।",
		"projects.scanFileObservedBytes": "ফাইলের আকার: {bytes} বাইট।",
		"projects.fileTooLarge": "64 KiB মেটাডেটা সীমা ছাড়িয়েছে।",
		"projects.catalogErrors": "সমস্যাযুক্ত ক্যাটালগ এন্ট্রি",
		"projects.returnToCurrentProject": "{name}-এ ফিরুন",
		"projects.lastProjectMissing":
			"শেষ খোলা প্রকল্পটি ক্যাটালগে নেই। চালিয়ে যেতে একটি প্রকল্প বেছে নিন।",
		"projects.sessionInvalid":
			"সংরক্ষিত প্রকল্পের অবস্থা পড়া যায়নি। একটি প্রকল্প বেছে নিন।",
	},
	pt: {
		"projects.checkoutLabel": "Origem",
		"projects.chooseCheckout": "Escolher pasta naia-adk",
		"projects.changeCheckout": "Abrir outro projeto",
		"projects.noCheckoutTitle": "Escolha sua pasta naia-adk",
		"projects.noCheckoutHint":
			"Escolha a pasta naia-adk com os projetos. Se a pasta salva não puder ser lida, escolha-a novamente ou redefina o caminho nas configurações.",
		"projects.loading": "Lendo projetos de naia-adk…",
		"projects.checkoutError": "Não foi possível ler os projetos de naia-adk",
		"projects.checkoutErrorHint":
			"Escolha uma pasta naia-adk com projects/. O caminho salvo pode ser redefinido nas configurações.",
		"projects.chooseAnother": "Escolher pasta novamente",
		"projects.searchPlaceholder": "Buscar por nome, ID, repositório ou origem",
		"projects.emptyHint":
			"Verifique em naia-adk/projects os arquivos projects/<project>/project.yaml com um project.id aninhado e não vazio. Para usar outra pasta naia-adk, redefina o caminho nas Configurações.",
		"projects.unsafePath":
			"O caminho está fora da pasta naia-adk e não foi lido.",
		"projects.stageOneEmpty":
			"Espaço reservado da etapa 2. O agente de código, o painel e as issues internas ainda não estão conectados.",
		"projects.scanEntryLimit":
			"{scanned} de {limit} entradas em naia-adk/projects foram verificadas; há mais.",
		"projects.scanRowLimit":
			"{shown} de {limit} linhas de projetos e erros estão visíveis; há mais linhas.",
		"projects.scanFileObservedBytes": "Tamanho do arquivo: {bytes} bytes.",
		"projects.fileTooLarge": "Excede o limite de metadados de 64 KiB.",
		"projects.catalogErrors": "Entradas do catálogo com problemas",
		"projects.returnToCurrentProject": "Voltar para {name}",
		"projects.lastProjectMissing":
			"O último projeto aberto não está no catálogo. Escolha um projeto.",
		"projects.sessionInvalid":
			"Não foi possível ler o estado salvo do projeto. Escolha um projeto.",
	},
	id: {
		"projects.checkoutLabel": "Sumber",
		"projects.chooseCheckout": "Pilih folder naia-adk",
		"projects.changeCheckout": "Buka proyek lain",
		"projects.noCheckoutTitle": "Pilih folder naia-adk Anda",
		"projects.noCheckoutHint":
			"Pilih folder naia-adk yang berisi proyek. Jika folder tersimpan tidak dapat dibaca, pilih lagi atau atur ulang jalurnya di Setelan.",
		"projects.loading": "Membaca proyek dari naia-adk…",
		"projects.checkoutError": "Proyek naia-adk tidak dapat dibaca",
		"projects.checkoutErrorHint":
			"Pilih folder naia-adk yang memiliki projects/. Jalur tersimpan dapat diatur ulang di Setelan.",
		"projects.chooseAnother": "Pilih folder lagi",
		"projects.searchPlaceholder":
			"Cari berdasarkan nama, ID, repositori, atau sumber",
		"projects.emptyHint":
			"Periksa file projects/<project>/project.yaml di naia-adk/projects dan pastikan project.id bertingkat tidak kosong. Untuk memakai folder naia-adk lain, atur ulang jalurnya di Setelan.",
		"projects.unsafePath":
			"Jalur berada di luar folder naia-adk sehingga tidak dibaca.",
		"projects.stageOneEmpty":
			"Placeholder tahap 2. Agen coding, dasbor, dan data isu internal belum terhubung.",
		"projects.scanEntryLimit":
			"Memeriksa {scanned} dari {limit} entri di naia-adk/projects; masih ada entri lain.",
		"projects.scanRowLimit":
			"Menampilkan {shown} dari {limit} baris proyek dan error; masih ada baris lain.",
		"projects.scanFileObservedBytes": "Ukuran file: {bytes} byte.",
		"projects.fileTooLarge": "Melebihi batas metadata 64 KiB.",
		"projects.catalogErrors": "Entri katalog yang bermasalah",
		"projects.returnToCurrentProject": "Kembali ke {name}",
		"projects.lastProjectMissing":
			"Proyek terakhir tidak ada di katalog. Pilih proyek untuk melanjutkan.",
		"projects.sessionInvalid":
			"Status proyek tersimpan tidak dapat dibaca. Pilih proyek.",
	},
	vi: {
		"projects.checkoutLabel": "Nguồn",
		"projects.chooseCheckout": "Chọn thư mục naia-adk",
		"projects.changeCheckout": "Mở dự án khác",
		"projects.noCheckoutTitle": "Chọn thư mục naia-adk của bạn",
		"projects.noCheckoutHint":
			"Chọn thư mục naia-adk chứa các dự án. Nếu không đọc được thư mục đã lưu, hãy chọn lại hoặc đặt lại đường dẫn trong Cài đặt.",
		"projects.loading": "Đang đọc dự án từ naia-adk…",
		"projects.checkoutError": "Không thể đọc dự án naia-adk",
		"projects.checkoutErrorHint":
			"Chọn thư mục naia-adk có projects/. Có thể đặt lại đường dẫn đã lưu trong Cài đặt.",
		"projects.chooseAnother": "Chọn lại thư mục",
		"projects.searchPlaceholder": "Tìm theo tên, ID, kho lưu trữ hoặc nguồn",
		"projects.emptyHint":
			"Kiểm tra các tệp projects/<project>/project.yaml trong naia-adk/projects để bảo đảm project.id lồng bên trong không rỗng. Để dùng thư mục naia-adk khác, hãy đặt lại đường dẫn trong Cài đặt.",
		"projects.unsafePath":
			"Đường dẫn nằm ngoài thư mục naia-adk nên không được đọc.",
		"projects.stageOneEmpty":
			"Màn hình giữ chỗ của giai đoạn 2. Tác nhân lập trình, bảng điều khiển và vấn đề nội bộ chưa được kết nối.",
		"projects.scanEntryLimit":
			"Đã quét {scanned}/{limit} mục trong naia-adk/projects; vẫn còn mục khác.",
		"projects.scanRowLimit":
			"Hiển thị {shown}/{limit} hàng dự án và lỗi; vẫn còn hàng khác.",
		"projects.scanFileObservedBytes": "Kích thước tệp: {bytes} byte.",
		"projects.fileTooLarge": "Vượt giới hạn siêu dữ liệu 64 KiB.",
		"projects.catalogErrors": "Mục danh mục có lỗi",
		"projects.returnToCurrentProject": "Quay lại {name}",
		"projects.lastProjectMissing":
			"Dự án mở gần nhất không còn trong danh mục. Hãy chọn dự án.",
		"projects.sessionInvalid":
			"Không đọc được trạng thái dự án đã lưu. Hãy chọn dự án.",
	},
};

export const SESSION_SAVE_TRANSLATIONS: Record<Locale, string> = {
	ar: "تعذر حفظ حالة المشروع. قد تُفقد التغييرات عند إعادة تشغيل الغلاف.",
	bn: "প্রকল্পের অবস্থা সংরক্ষণ করা যায়নি। শেল পুনরায় চালু হলে পরিবর্তন হারিয়ে যেতে পারে।",
	de: "Der Projektstatus konnte nicht gespeichert werden. Änderungen können beim Neustart der Shell verloren gehen.",
	en: PROJECT_BASE_ENGLISH_TRANSLATIONS["projects.sessionSaveFailed"],
	es: "No se pudo guardar el estado del proyecto. Los cambios podrían perderse al reiniciar la shell.",
	fr: "L’état du projet n’a pas pu être enregistré. Les modifications peuvent être perdues au redémarrage du shell.",
	hi: "प्रोजेक्ट की स्थिति सहेजी नहीं जा सकी। शेल फिर शुरू होने पर बदलाव खो सकते हैं।",
	id: "Status proyek tidak dapat disimpan. Perubahan dapat hilang saat shell dimulai ulang.",
	ja: "プロジェクトの状態を保存できませんでした。シェルの再起動時に変更が失われる可能性があります。",
	ko: "프로젝트 상태를 저장하지 못했습니다. 셸을 다시 시작하면 변경 사항이 복원되지 않을 수 있습니다.",
	pt: "Não foi possível salvar o estado do projeto. As alterações podem ser perdidas ao reiniciar o shell.",
	ru: "Не удалось сохранить состояние проекта. После перезапуска оболочки изменения могут быть потеряны.",
	vi: "Không thể lưu trạng thái dự án. Thay đổi có thể mất khi khởi động lại shell.",
	zh: "无法保存项目状态。重启 shell 后，所做更改可能会丢失。",
};
