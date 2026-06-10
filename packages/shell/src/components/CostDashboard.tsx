import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState } from "react";
import {
	LAB_GATEWAY_URL,
	getNaiaKeySecure,
	hasNaiaKeySecure,
} from "../lib/config";
import { getLocale, t } from "../lib/i18n";
import { parseLabCredits } from "../lib/lab-balance";
import { Logger } from "../lib/logger";
import type { ChatMessage, CostEntry } from "../lib/types";

interface CostGroup {
	provider: string;
	model: string;
	count: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
}

function groupCosts(
	messages: ChatMessage[],
	sessionCostEntries: CostEntry[] = [],
): CostGroup[] {
	const map = new Map<string, CostGroup>();
	for (const msg of messages) {
		if (!msg.cost) continue;
		const key = `${msg.cost.provider}|${msg.cost.model}`;
		const existing = map.get(key);
		if (existing) {
			existing.count++;
			existing.inputTokens += msg.cost.inputTokens;
			existing.outputTokens += msg.cost.outputTokens;
			existing.cost += msg.cost.cost;
		} else {
			map.set(key, {
				provider: msg.cost.provider,
				model: msg.cost.model,
				count: 1,
				inputTokens: msg.cost.inputTokens,
				outputTokens: msg.cost.outputTokens,
				cost: msg.cost.cost,
			});
		}
	}
	// Merge session-level entries (e.g. STT costs not attached to messages)
	for (const entry of sessionCostEntries) {
		const key = `${entry.provider}|${entry.model}`;
		const existing = map.get(key);
		if (existing) {
			existing.inputTokens += entry.inputTokens;
			existing.outputTokens += entry.outputTokens;
			existing.cost += entry.cost;
		} else {
			map.set(key, {
				provider: entry.provider,
				model: entry.model,
				count: 0,
				inputTokens: entry.inputTokens,
				outputTokens: entry.outputTokens,
				cost: entry.cost,
			});
		}
	}
	return Array.from(map.values());
}

function formatCost(cost: number): string {
	if (cost < 0.001) return `$${cost.toFixed(6)}`;
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(3)}`;
}

const GATEWAY_URL = LAB_GATEWAY_URL;

// Simple cache to avoid re-fetching balance on every mount
let balanceCache: { value: number; timestamp: number } | null = null;
const BALANCE_CACHE_TTL = 30_000; // 30 seconds

function LabBalanceSection() {
	const [balance, setBalance] = useState<number | null>(
		balanceCache && Date.now() - balanceCache.timestamp < BALANCE_CACHE_TTL
			? balanceCache.value
			: null,
	);
	const [loading, setLoading] = useState(balance === null);
	const [error, setError] = useState(false);

	const fetchBalance = useCallback(async () => {
		const naiaKey = await getNaiaKeySecure();
		if (!naiaKey) {
			setLoading(false);
			return;
		}
		fetch(`${GATEWAY_URL}/v1/profile/balance`, {
			headers: { "X-AnyLLM-Key": `Bearer ${naiaKey}` },
		})
			.then((res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return res.json();
			})
			.then((data: unknown) => {
				const val = parseLabCredits(data) ?? 0;
				balanceCache = { value: val, timestamp: Date.now() };
				setBalance(val);
				setError(false);
			})
			.catch((err) => {
				Logger.warn("CostDashboard", "Lab balance fetch failed", {
					error: String(err),
				});
				setError(true);
			})
			.finally(() => setLoading(false));
	}, []);

	useEffect(() => {
		// Use cached value if fresh
		if (
			balanceCache &&
			Date.now() - balanceCache.timestamp < BALANCE_CACHE_TTL
		) {
			setBalance(balanceCache.value);
			setLoading(false);
			return;
		}
		fetchBalance();
	}, [fetchBalance]);

	useEffect(() => {
		const unlisten = listen("naia_auth_complete", () => {
			balanceCache = null;
			setLoading(true);
			fetchBalance();
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, [fetchBalance]);

	if (loading) {
		return <div className="lab-balance-row">{t("cost.labLoading")}</div>;
	}
	if (error) {
		return (
			<div className="lab-balance-row lab-balance-error">
				{t("cost.labError")}
			</div>
		);
	}
	if (balance === null) return null;

	return (
		<div className="lab-balance-section">
			<div className="lab-balance-row">
				<span className="lab-balance-label">{t("cost.labBalance")}</span>
				<span className="lab-balance-value">
					{balance.toFixed(2)} {t("cost.labCredits")}
				</span>
			</div>
			<button
				type="button"
				className="lab-charge-btn"
				onClick={() =>
					openUrl(`https://naia.nextain.io/${getLocale()}/billing`).catch(
						() => {},
					)
				}
			>
				{t("cost.labCharge")}
			</button>
		</div>
	);
}

export function CostDashboard({
	messages,
	sessionCostEntries = [],
}: {
	messages: ChatMessage[];
	sessionCostEntries?: CostEntry[];
}) {
	const groups = groupCosts(messages, sessionCostEntries);
	const [showLabBalance, setShowLabBalance] = useState(false);

	useEffect(() => {
		hasNaiaKeySecure().then(setShowLabBalance);
	}, []);

	useEffect(() => {
		const unlisten = listen("naia_auth_complete", () => {
			setShowLabBalance(true);
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	if (groups.length === 0 && !showLabBalance) {
		return <div className="cost-dashboard-empty">{t("cost.empty")}</div>;
	}

	const totalCost = groups.reduce((sum, g) => sum + g.cost, 0);
	const totalInput = groups.reduce((sum, g) => sum + g.inputTokens, 0);
	const totalOutput = groups.reduce((sum, g) => sum + g.outputTokens, 0);

	return (
		<div className="cost-dashboard">
			{showLabBalance && <LabBalanceSection />}
			<div className="cost-dashboard-title">{t("cost.title")}</div>
			<table className="cost-table">
				<thead>
					<tr>
						<th>{t("cost.provider")}</th>
						<th>{t("cost.model")}</th>
						<th>{t("cost.messages")}</th>
						<th>{t("cost.inputTokens")}</th>
						<th>{t("cost.outputTokens")}</th>
						<th>{t("cost.total")}</th>
					</tr>
				</thead>
				<tbody>
					{groups.map((g) => (
						<tr key={`${g.provider}|${g.model}`}>
							<td>{g.provider}</td>
							<td>{g.model}</td>
							<td>{g.count > 0 ? g.count : "-"}</td>
							<td>
								{g.inputTokens > 0 ? g.inputTokens.toLocaleString() : "-"}
							</td>
							<td>
								{g.outputTokens > 0 ? g.outputTokens.toLocaleString() : "-"}
							</td>
							<td>{formatCost(g.cost)}</td>
						</tr>
					))}
				</tbody>
				<tfoot>
					<tr>
						<td colSpan={3}>{t("cost.total")}</td>
						<td>{totalInput.toLocaleString()}</td>
						<td>{totalOutput.toLocaleString()}</td>
						<td>{formatCost(totalCost)}</td>
					</tr>
				</tfoot>
			</table>
		</div>
	);
}

// Export for testing
export { groupCosts };
