import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const outBase = "/home/luke/dev/naia.nextain.io/public/manual";

const texts = {
	ko: {
		dashboardTitle: "대시보드",
		usageTitle: "사용량",
		logsTitle: "로그",
		keysTitle: "API 키",
		credit: "크레딧 잔액",
		req: "총 요청 수",
		tok: "총 토큰 수",
		spend: "총 지출",
		period: "현재 기간",
		active: "활성",
		dailyReq: "일별 요청 수",
		dailyTok: "일별 토큰 수",
		dailyCost: "일별 비용",
		filter: "필터",
		status: "상태",
		model: "모델",
		time: "시간",
		cost: "비용",
		create: "새 키 만들기",
		keyName: "키 이름",
		expires: "만료일",
		createdAt: "생성일",
		actions: "작업",
		delete: "삭제",
	},
	en: {
		dashboardTitle: "Dashboard",
		usageTitle: "Usage",
		logsTitle: "Logs",
		keysTitle: "API Keys",
		credit: "Credit Balance",
		req: "Total Requests",
		tok: "Total Tokens",
		spend: "Total Spend",
		period: "Current Period",
		active: "Active",
		dailyReq: "Requests per Day",
		dailyTok: "Tokens per Day",
		dailyCost: "Spend per Day",
		filter: "Filters",
		status: "Status",
		model: "Model",
		time: "Time",
		cost: "Cost",
		create: "Create New Key",
		keyName: "Key Name",
		expires: "Expires",
		createdAt: "Created",
		actions: "Actions",
		delete: "Delete",
	},
};

const baseCss = `
  :root { --bg:#f7f5ef; --card:#ffffff; --line:#e8e2d4; --ink:#2f2a22; --muted:#7a7468; --brand:#8b6f3d; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: ui-sans-serif, -apple-system, Segoe UI, Roboto, sans-serif; background: radial-gradient(circle at 20% 0%, #fff8e9, var(--bg)); color:var(--ink); }
  .wrap { width: 380px; height: 720px; padding: 14px; }
  h1 { margin:0 0 12px; font-size:22px; }
  .grid4 { display:grid; grid-template-columns: repeat(2,1fr); gap:10px; margin-bottom:10px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:10px; }
  .label { font-size:11px; color:var(--muted); margin-bottom:4px; }
  .val { font-size:18px; font-weight:700; }
  .small { font-size:12px; color:var(--muted); }
  .section { display:grid; grid-template-columns: 1fr; gap:10px; }
  .panel-title { font-size:12px; margin-bottom:8px; color:#594c33; font-weight:600; }
  .chart { height:140px; border:1px solid var(--line); border-radius:10px; background:linear-gradient(180deg,#fff,#fbf8f1); padding:8px; display:flex; align-items:flex-end; gap:4px; }
  .bar { width:8px; background:#c9a35f; border-radius:4px 4px 2px 2px; }
  .bars2 .bar { background:#9f7f46; }
  .bars3 .bar { background:#6f8e74; }
  table { width:100%; border-collapse:collapse; font-size:10px; }
  th,td { padding:6px; border-bottom:1px solid var(--line); text-align:left; }
  th { color:var(--muted); font-weight:600; }
  .badge { display:inline-block; padding:3px 6px; border-radius:999px; border:1px solid #d9ceb8; font-size:10px; }
  .btn { display:inline-block; padding:4px 7px; border:1px solid var(--line); border-radius:8px; font-size:10px; }
  .toolbar { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; }
  .input { padding:6px 8px; border:1px solid var(--line); border-radius:8px; background:#fff; font-size:10px; }
`;

function htmlDashboard(t) {
	return `<!doctype html><html><head><style>${baseCss}</style></head><body><div class="wrap">
    <h1>${t.dashboardTitle}</h1>
    <div class="grid4">
      <div class="card"><div class="label">${t.credit}</div><div class="val">18.4</div></div>
      <div class="card"><div class="label">${t.req}</div><div class="val">124</div></div>
      <div class="card"><div class="label">${t.tok}</div><div class="val">48,920</div></div>
      <div class="card"><div class="label">${t.spend}</div><div class="val">$2.48</div></div>
    </div>
    <div class="section">
      <div class="card"><div class="panel-title">${t.period}</div><div class="small">2026-02-01 ~ 2026-02-19</div><div style="margin-top:12px" class="badge">${t.active}</div></div>
      <div class="card"><div class="panel-title">Quick Links</div><div class="small">Usage / Logs / Keys / Billing</div></div>
    </div>
  </div></body></html>`;
}

function htmlUsage(t) {
	const bars = [40, 70, 55, 90, 65, 45, 80, 60, 38, 75, 58, 88];
	const makeBars = (cls, mul = 1) =>
		`<div class="chart ${cls}">${bars.map((v) => `<div class="bar" style="height:${Math.max(20, Math.round(v * mul))}px"></div>`).join("")}</div>`;
	return `<!doctype html><html><head><style>${baseCss}</style></head><body><div class="wrap">
    <h1>${t.usageTitle}</h1>
    <div class="grid4">
      <div class="card"><div class="label">${t.req}</div><div class="val">124</div></div>
      <div class="card"><div class="label">${t.tok}</div><div class="val">48,920</div></div>
      <div class="card"><div class="label">${t.spend}</div><div class="val">$2.48</div></div>
      <div class="card"><div class="label">Period</div><div class="val" style="font-size:24px">30 days</div></div>
    </div>
    <div class="section">
      <div class="card"><div class="panel-title">${t.dailyReq}</div>${makeBars("bars1", 1)}</div>
      <div class="card"><div class="panel-title">${t.dailyTok}</div>${makeBars("bars2", 0.9)}</div>
      <div class="card"><div class="panel-title">${t.dailyCost}</div>${makeBars("bars3", 0.7)}</div>
    </div>
  </div></body></html>`;
}

function htmlLogs(t) {
	const rows = [
		["2026-02-19 10:21", "200", "gpt-4o-mini", "1,252", "$0.0124"],
		["2026-02-19 10:16", "200", "claude-3-5-haiku", "884", "$0.0071"],
		["2026-02-19 10:11", "429", "gemini-2.5-flash", "0", "$0.0000"],
		["2026-02-19 09:58", "200", "gpt-4.1-mini", "2,030", "$0.0188"],
		["2026-02-19 09:43", "200", "gemini-2.5-flash", "1,440", "$0.0102"],
	];
	return `<!doctype html><html><head><style>${baseCss}</style></head><body><div class="wrap">
    <h1>${t.logsTitle}</h1>
    <div class="card">
      <div class="toolbar">
        <div class="input">${t.filter}</div>
        <div class="input">${t.status}: 200</div>
        <div class="input">${t.model}: All</div>
      </div>
      <table>
        <thead><tr><th>${t.time}</th><th>${t.status}</th><th>${t.model}</th><th>Tokens</th><th>${t.cost}</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td>${r[0]}</td><td><span class="badge">${r[1]}</span></td><td>${r[2]}</td><td>${r[3]}</td><td>${r[4]}</td></tr>`).join("")}</tbody>
      </table>
    </div>
  </div></body></html>`;
}

function htmlKeys(t) {
	const rows = [
		["desktop-main", "2026-02-18", "2026-08-18", "active"],
		["automation-ci", "2026-02-15", "2026-05-15", "active"],
		["old-key", "2025-12-01", "2026-02-01", "revoked"],
	];
	return `<!doctype html><html><head><style>${baseCss}</style></head><body><div class="wrap">
    <h1>${t.keysTitle}</h1>
    <div class="card" style="margin-bottom:14px">
      <div class="panel-title">${t.create}</div>
      <div class="toolbar">
        <div class="input" style="min-width:280px">${t.keyName}</div>
        <div class="input">${t.expires}</div>
        <div class="btn">Create</div>
      </div>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>${t.keyName}</th><th>${t.createdAt}</th><th>${t.expires}</th><th>${t.status}</th><th>${t.actions}</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td><span class="badge">${r[3]}</span></td><td><span class="btn">${t.delete}</span></td></tr>`).join("")}</tbody>
      </table>
    </div>
  </div></body></html>`;
}

const pages = [
	["lab-dashboard.png", htmlDashboard],
	["lab-usage.png", htmlUsage],
	["lab-logs.png", htmlLogs],
	["lab-keys.png", htmlKeys],
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
	viewport: { width: 380, height: 720 },
	deviceScaleFactor: 3,
});
const page = await ctx.newPage();

for (const lang of ["ko", "en"]) {
	const t = texts[lang];
	const outDir = path.join(outBase, lang);
	fs.mkdirSync(outDir, { recursive: true });

	for (const [filename, render] of pages) {
		await page.setContent(render(t), { waitUntil: "domcontentloaded" });
		await page.screenshot({
			path: path.join(outDir, filename),
			fullPage: false,
		});
	}
}

await browser.close();
console.log("Generated lab manual images: ko/en x 4");
