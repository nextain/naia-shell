import { getLocale } from "../lib/i18n";
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
	const isKo = locale === "ko";
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

	let title = "";
	let body = "";
	if (decision.status === "login_required") {
		title = isKo
			? `${slug} 주소는 주인 전용 공간입니다`
			: `/${slug} is a private Naia workspace`;
		body = isKo
			? "이 주소의 대화와 기억을 열려면 주소 주인 계정으로 로그인해 주세요. 로그인 없이 체험하려면 공용 웹 나이아(/app)로 이동할 수 있습니다."
			: "Please sign in as the owner of this address to access this workspace, or switch to the public Web Naia (/app) to try without signing in.";
	} else if (decision.status === "forbidden_not_owner") {
		title = isKo
			? `${slug} 주소의 주인이 아닙니다`
			: `You are not the owner of /${slug}`;
		body = isKo
			? "현재 다른 계정으로 로그인되어 있어 이 개인 주소 공간에 접근할 수 없습니다. 주소 주인 본인의 계정으로 다시 로그인하거나 내 나이아(/app)로 이동해 주세요."
			: "You are signed in with a different account. Sign in as the address owner or open your own workspace at /app.";
	} else if (decision.status === "not_found") {
		title = isKo
			? `등록되지 않은 나이아 주소(${slug})입니다`
			: `Address "${slug}" was not found`;
		body = isKo
			? "주소를 다시 확인하거나 공용 웹 나이아(/app)에서 바로 시작해 보세요."
			: "Check the address spelling or start right away at /app.";
	} else {
		title = isKo
			? `올바르지 않은 나이아 주소(${slug})입니다`
			: `Invalid Naia address "${slug}"`;
		body = isKo
			? "영어 소문자·숫자·붙임표(-) 3~30자 규칙에 맞는 주소인지 확인해 주세요."
			: "Naia addresses use 3–30 lowercase letters, digits, and hyphens.";
	}

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
							{isKo ? "주인 계정으로 로그인" : "Sign in as Owner"}
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
						{isKo
							? "로그인 없이 무료 체험 (/app 이동)"
							: "Try Free Without Login (/app)"}
					</button>
				</div>
			</section>
		</main>
	);
}
