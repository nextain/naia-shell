import { useCallback, useEffect, useMemo, useState } from "react";
import {
	canonicalRoot,
	wireWorkspaceContextLive,
	type ContextManifest,
	type Diagnostic,
	type WorkspaceContextService,
} from "@nextain/naia-os-core/composition";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "../../lib/i18n";

// #501 워크스페이스 컨텍스트 표면 (UC-WORKSPACE-CONTEXT-*).
// 이 앱이 답해야 하는 질문은 "무엇을 읽었는가"가 아니라 "왜 그것을 읽었는가"다.
// 근거 없이 목록만 보여 주면 사용자는 나이아가 무엇을 근거로 답했는지 알 수 없다.

type AppState =
	| { kind: "no-root" }
	| { kind: "loading" }
	| { kind: "ok"; manifest: ContextManifest }
	| { kind: "failed"; diagnostics: readonly Diagnostic[] };

export interface WorkspaceContextAppProps {
	workspaceRoot: string;
	/** 테스트가 대역 서비스를 넣는다. 없으면 Tauri 실배선. */
	service?: WorkspaceContextService;
}

function scopeLabel(manifest: ContextManifest): string {
	return manifest.scope.kind === "root"
		? t("workspace.contextScopeRoot")
		: manifest.scope.name;
}

export function WorkspaceContextApp(props: WorkspaceContextAppProps) {
	const service = useMemo(
		() => props.service ?? wireWorkspaceContextLive({ invoke, listen }),
		[props.service],
	);
	const [state, setState] = useState<AppState>({ kind: "no-root" });

	const apply = useCallback(
		(outcome: Awaited<ReturnType<WorkspaceContextService["discover"]>>) => {
			setState(
				outcome.ok
					? { kind: "ok", manifest: outcome.manifest }
					: { kind: "failed", diagnostics: outcome.diagnostics },
			);
		},
		[],
	);

	const discover = useCallback(async () => {
		if (!props.workspaceRoot) {
			setState({ kind: "no-root" });
			return;
		}
		setState({ kind: "loading" });
		apply(await service.discover(canonicalRoot(props.workspaceRoot), { topics: [] }));
	}, [apply, props.workspaceRoot, service]);

	useEffect(() => {
		void discover();
	}, [discover]);

	const enter = useCallback(
		async (name: string) => {
			setState({ kind: "loading" });
			apply(await service.enterProject(name, { topics: [] }));
		},
		[apply, service],
	);

	const projects = state.kind === "ok" ? service.projects() : [];
	const inProject = state.kind === "ok" && state.manifest.scope.kind === "project";

	return (
		<section
			className="herdr-workspace__context"
			aria-label={t("workspace.contextTitle")}
			data-testid="workspace-context-app"
		>
			<header className="herdr-workspace__section-title">
				<span>{t("workspace.contextTitle")}</span>
				{state.kind === "ok" && (
					<span data-testid="workspace-context-scope">
						{scopeLabel(state.manifest)} · {t("workspace.contextRevision")}{" "}
						{state.manifest.revision.value}
					</span>
				)}
				<button
					type="button"
					data-usage-event="workspace-context-app.button-1.click"
					onClick={() => void discover()}
					data-testid="workspace-context-refresh"
					disabled={state.kind === "loading" || !props.workspaceRoot}
				>
					{t("workspace.contextRefresh")}
				</button>
			</header>

			{state.kind === "no-root" && (
				<p data-testid="workspace-context-no-root">{t("workspace.contextNoRoot")}</p>
			)}

			{state.kind === "loading" && (
				<p data-testid="workspace-context-loading">{t("workspace.contextLoading")}</p>
			)}

			{state.kind === "failed" && (
				<div data-testid="workspace-context-error">
					<p>{t("workspace.contextFailed")}</p>
					<ul>
						{state.diagnostics.map((d) => (
							<li key={`${d.code}:${d.target}`} data-testid="workspace-context-diagnostic">
								<code>{d.target}</code>
								<span>{d.code}</span>
								<span>{d.searchedIn}</span>
								<em>{d.action}</em>
							</li>
						))}
					</ul>
				</div>
			)}

			{state.kind === "ok" && (
				<>
					{state.manifest.selection.loaded.length === 0 ? (
						<p data-testid="workspace-context-empty">{t("workspace.contextEmpty")}</p>
					) : (
						<ul data-testid="workspace-context-documents">
							{state.manifest.selection.loaded.map((doc) => (
								<li key={doc.ref.id} data-testid="workspace-context-document">
									<code>{doc.ref.path}</code>
									<span data-testid="workspace-context-reason">
										{doc.reason === "mandatory"
											? t("workspace.contextReasonMandatory")
											: t("workspace.contextReasonIntent")}
									</span>
									<span>
										{t("workspace.contextDeclaredBy")}: {doc.declaredBy}
									</span>
								</li>
							))}
						</ul>
					)}

					{state.manifest.selection.dropped.length > 0 && (
						<p data-testid="workspace-context-dropped">
							{t("workspace.contextDropped")}:{" "}
							{state.manifest.selection.dropped.map((d) => d.path).join(", ")}
						</p>
					)}

					{projects.length > 0 && (
						<nav data-testid="workspace-context-projects" aria-label={t("workspace.contextProjects")}>
							{projects.map((p) => (
								<button
									key={p.name}
									type="button"
									data-usage-event="workspace-context-app.button-2.click"
									onClick={() => void enter(p.name)}
									data-testid={`workspace-context-project-${p.name}`}
									aria-current={
										state.manifest.scope.kind === "project" && state.manifest.scope.name === p.name
									}
								>
									{p.name}
								</button>
							))}
							{inProject && (
								<button
									type="button"
									data-usage-event="workspace-context-app.button-3.click"
									onClick={() => void discover()}
									data-testid="workspace-context-back-to-root"
								>
									{t("workspace.contextBackToRoot")}
								</button>
							)}
						</nav>
					)}
				</>
			)}
		</section>
	);
}
