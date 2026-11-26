import { getLocale, t } from "../lib/i18n";
import {
	logoutWebSession,
	startWebLoginRedirect,
} from "../lib/web-runtime/web-auth";
import type { SlugOwnershipDecision } from "../lib/web-runtime/web-slug-guard";

interface WebSlugOwnerGuardProps {
	decision: Exclude<SlugOwnershipDecision, { status: "none" } | { status: "authorized" }>;
}

export function WebSlugOwnerGuard({ decision }: WebSlugOwnerGuardProps) {
	const locale = getLocale();
	const slug = decision.slug;

	const handleOwnerLogin = () => {
		if (decision.status === "forbidden_not_owner") {
			logoutWebSession();
		}
		startWebLoginRedirect({ lang: locale });
	};

	const goToPublicApp = () => {
		if (typeof window !== "undefined") {
			window.location.assign("/app");
		}
	};

	const title = t(`webSlugGuard.${decision.status}.title`, { slug });
	const body = t(`webSlugGuard.${decision.status}.body`);

	return (
		<main
			data-testid="web-slug-owner-guard"
			data-guard-status={decision.status}
			style={{
				minHeight: "100dvh",
				display: "grid",
				placeItems: "center",
				padding: 24,
				background:
					"radial-gradient(circle at 50% 20%, rgba(79, 70, 229, 0.22), #060d14 68%)",
				color: "#f8fafc",
			}}
		>
			<section
				style={{
					maxWidth: 440,
					width: "100%",
					padding: "28px 26px",
					borderRadius: 18,
					border: "1px solid rgba(148, 163, 184, 0.25)",
					background: "rgba(11, 17, 30, 0.94)",
					boxShadow: "0 24px 60px rgba(0, 0, 0, 0.65)",
					textAlign: "center",
				}}
			>
				<div
					style={{
						display: "inline-block",
						padding: "4px 12px",
						borderRadius: 999,
						fontSize: 12,
						fontWeight: 600,
						background: "rgba(99, 102, 241, 0.2)",
						color: "#a5b4fc",
						marginBottom: 14,
					}}
				>
					🔒 naia.land/u/{slug}
				</div>
				<h1 style={{ margin: "0 0 10px", fontSize: 20, fontWeight: 700 }}>
					{title}
				</h1>
				<p
					style={{
						margin: "0 0 22px",
						fontSize: 13.5,
						lineHeight: 1.6,
						color: "#94a3b8",
					}}
				>
					{body}
				</p>
				<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
					{(decision.status === "login_required" ||
						decision.status === "forbidden_not_owner") && (
						<button
							type="button"
							data-testid="web-slug-owner-login-btn"
							onClick={handleOwnerLogin}
							style={{
								width: "100%",
								padding: "11px 16px",
								borderRadius: 10,
								border: "none",
								background: "linear-gradient(135deg, #6366f1, #4f46e5)",
								color: "#ffffff",
								fontWeight: 700,
								fontSize: 14,
								cursor: "pointer",
							}}
						>
							{t("webSlugGuard.ownerLogin")}
						</button>
					)}
					<button
						type="button"
						data-testid="web-slug-go-public-app-btn"
						onClick={goToPublicApp}
						style={{
							width: "100%",
							padding: "10px 14px",
							borderRadius: 10,
							border: "1px solid rgba(148, 163, 184, 0.28)",
							background: "rgba(30, 41, 59, 0.65)",
							color: "#e2e8f0",
							fontWeight: 600,
							fontSize: 13,
							cursor: "pointer",
						}}
					>
						{t("webSlugGuard.tryPublicApp")}
					</button>
				</div>
			</section>
		</main>
	);
}
