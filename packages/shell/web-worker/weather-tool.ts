/**
 * 웹판 날씨 도구. 앱의 get_weather(open-meteo, 키 불필요)와 같은 이름·같은 출처다.
 * 브라우저 Worker 가 직접 open-meteo 를 부르므로 서버(나이아·웹GPU 경로) 어느 쪽이든 같은 도구다.
 */
export const WEATHER_TOOL_NAME = "get_weather";

export const WEATHER_TOOL_SPEC = {
	name: WEATHER_TOOL_NAME,
	description:
		"도시의 현재 날씨와 오늘 최고·최저 기온, 비 올 확률을 알려 줍니다. 인자: {city} 도시 이름(예: 서울, 부산, Tokyo) 또는 {latitude, longitude}. 날씨·기온·비·우산을 물으면 반드시 이 도구를 먼저 부릅니다.",
	parameters: {
		type: "object",
		properties: {
			city: { type: "string" },
			latitude: { type: "number" },
			longitude: { type: "number" },
		},
	},
} as const;

type Place = { name: string; latitude: number; longitude: number };

/** 이름 풀이가 흔들리는(동명 산·마을) 한국 주요 도시는 좌표를 직접 둔다. */
const KNOWN_CITIES: Record<string, Place> = {
	서울: { name: "서울", latitude: 37.5665, longitude: 126.978 },
	부산: { name: "부산", latitude: 35.1796, longitude: 129.0756 },
	인천: { name: "인천", latitude: 37.4563, longitude: 126.7052 },
	대구: { name: "대구", latitude: 35.8714, longitude: 128.6014 },
	대전: { name: "대전", latitude: 36.3504, longitude: 127.3845 },
	광주: { name: "광주", latitude: 35.1595, longitude: 126.8526 },
	울산: { name: "울산", latitude: 35.5384, longitude: 129.3114 },
	수원: { name: "수원", latitude: 37.2636, longitude: 127.0286 },
	세종: { name: "세종", latitude: 36.48, longitude: 127.289 },
	제주: { name: "제주", latitude: 33.4996, longitude: 126.5312 },
	전주: { name: "전주", latitude: 35.8242, longitude: 127.148 },
	춘천: { name: "춘천", latitude: 37.8813, longitude: 127.7298 },
	강릉: { name: "강릉", latitude: 37.7519, longitude: 128.8761 },
	도쿄: { name: "도쿄", latitude: 35.6762, longitude: 139.6503 },
	오사카: { name: "오사카", latitude: 34.6937, longitude: 135.5023 },
	베이징: { name: "베이징", latitude: 39.9042, longitude: 116.4074 },
	상하이: { name: "상하이", latitude: 31.2304, longitude: 121.4737 },
	뉴욕: { name: "뉴욕", latitude: 40.7128, longitude: -74.006 },
	런던: { name: "런던", latitude: 51.5072, longitude: -0.1276 },
	파리: { name: "파리", latitude: 48.8566, longitude: 2.3522 },
};

const WMO: Array<[number[], string]> = [
	[[0], "맑음"],
	[[1], "대체로 맑음"],
	[[2], "구름 조금"],
	[[3], "흐림"],
	[[45, 48], "안개"],
	[[51, 53, 55, 56, 57], "이슬비"],
	[[61, 63, 65, 66, 67], "비"],
	[[71, 73, 75, 77], "눈"],
	[[80, 81, 82], "소나기"],
	[[85, 86], "눈 소나기"],
	[[95, 96, 99], "천둥번개"],
];

export function describeWeatherCode(code: number): string {
	return WMO.find(([codes]) => codes.includes(code))?.[1] ?? `날씨 코드 ${code}`;
}

type FetchLike = (
	url: string,
	init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function cityKey(raw: string): string {
	return raw
		.trim()
		.replace(/(특별시|광역시|특별자치시|특별자치도|시)$/u, "")
		.replace(/\s+/g, "");
}

async function resolvePlace(
	city: string,
	doFetch: FetchLike,
	signal?: AbortSignal,
): Promise<Place | null> {
	const known = KNOWN_CITIES[cityKey(city)];
	if (known) return known;
	const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city.trim())}&count=5&language=ko`;
	const res = await doFetch(url, signal ? { signal } : {});
	if (!res.ok) throw new Error(`geocoding HTTP ${res.status}`);
	const body = (await res.json()) as {
		results?: Array<{
			name?: string;
			latitude?: number;
			longitude?: number;
			feature_code?: string;
		}>;
	};
	const hits = body.results ?? [];
	// 산·곶 같은 지형보다 사람이 사는 곳(PPL*, ADM*)을 먼저 고른다.
	const picked =
		hits.find((h) => /^(PPL|ADM)/.test(h.feature_code ?? "")) ?? hits[0];
	if (
		!picked ||
		typeof picked.latitude !== "number" ||
		typeof picked.longitude !== "number"
	)
		return null;
	return {
		name: picked.name ?? city.trim(),
		latitude: picked.latitude,
		longitude: picked.longitude,
	};
}

export async function executeWeatherTool(
	args: unknown,
	opts: { signal?: AbortSignal; fetch?: FetchLike } = {},
): Promise<{ output: string; isError?: boolean }> {
	const doFetch: FetchLike =
		opts.fetch ?? ((url, init) => fetch(url, init as RequestInit));
	try {
		const a = (args && typeof args === "object" ? args : {}) as Record<
			string,
			unknown
		>;
		let place: Place | null = null;
		if (typeof a.city === "string" && a.city.trim()) {
			place = await resolvePlace(a.city, doFetch, opts.signal);
			if (!place) return { output: `Error: 도시를 찾지 못했습니다: ${a.city}`, isError: true };
		} else if (
			typeof a.latitude === "number" &&
			typeof a.longitude === "number" &&
			Math.abs(a.latitude) <= 90 &&
			Math.abs(a.longitude) <= 180
		) {
			place = { name: "", latitude: a.latitude, longitude: a.longitude };
		} else {
			return { output: "Error: city 또는 latitude/longitude 가 필요합니다", isError: true };
		}
		const url =
			"https://api.open-meteo.com/v1/forecast" +
			`?latitude=${encodeURIComponent(place.latitude)}&longitude=${encodeURIComponent(place.longitude)}` +
			"&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m" +
			"&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=1&timezone=auto";
		const res = await doFetch(url, opts.signal ? { signal: opts.signal } : {});
		if (!res.ok) return { output: `Error: open-meteo HTTP ${res.status}`, isError: true };
		const j = (await res.json()) as {
			current?: Record<string, unknown>;
			daily?: Record<string, unknown[]>;
		};
		const num = (v: unknown): number | null =>
			typeof v === "number" && Number.isFinite(v) ? v : null;
		const temp = num(j.current?.temperature_2m);
		const code = num(j.current?.weather_code);
		if (temp === null || code === null)
			return { output: "Error: 날씨 응답이 올바르지 않습니다", isError: true };
		const feels = num(j.current?.apparent_temperature);
		const humidity = num(j.current?.relative_humidity_2m);
		const wind = num(j.current?.wind_speed_10m);
		const max = num(j.daily?.temperature_2m_max?.[0]);
		const min = num(j.daily?.temperature_2m_min?.[0]);
		const rain = num(j.daily?.precipitation_probability_max?.[0]);
		const parts = [
			`${place.name ? `${place.name} ` : ""}현재 ${describeWeatherCode(code)}, 기온 ${temp}°C`,
			feels !== null ? `체감 ${feels}°C` : "",
			humidity !== null ? `습도 ${humidity}%` : "",
			wind !== null ? `바람 ${wind}km/h` : "",
			min !== null && max !== null ? `오늘 최저 ${min}°C·최고 ${max}°C` : "",
			rain !== null ? `비 올 확률 ${rain}%` : "",
		].filter(Boolean);
		return { output: `${parts.join(", ")} (출처: open-meteo)` };
	} catch (e) {
		if (opts.signal?.aborted) return { output: "Error: cancelled", isError: true };
		return { output: `Error: ${e instanceof Error ? e.message : "날씨를 가져오지 못했습니다"}`, isError: true };
	}
}
