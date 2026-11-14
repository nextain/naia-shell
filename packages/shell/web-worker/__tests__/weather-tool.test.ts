import { describe, expect, it } from "vitest";
import { describeWeatherCode, executeWeatherTool } from "../weather-tool";

const forecast = {
	current: {
		temperature_2m: 12.3,
		apparent_temperature: 10,
		relative_humidity_2m: 50,
		weather_code: 61,
		wind_speed_10m: 4,
	},
	daily: {
		temperature_2m_max: [15],
		temperature_2m_min: [7],
		precipitation_probability_max: [70],
	},
};

describe("get_weather", () => {
	it("서울은 좌표표로 바로 풀어 예보만 부른다", async () => {
		const urls: string[] = [];
		const r = await executeWeatherTool(
			{ city: "서울" },
			{
				fetch: async (u) => {
					urls.push(u);
					return { ok: true, status: 200, json: async () => forecast };
				},
			},
		);
		expect(urls).toHaveLength(1);
		expect(urls[0]).toContain("latitude=37.5665");
		expect(r.isError).toBeUndefined();
		expect(r.output).toContain("서울 현재 비, 기온 12.3°C");
		expect(r.output).toContain("비 올 확률 70%");
	});
	it("모르는 도시는 지오코딩에서 사람이 사는 곳을 고른다", async () => {
		const r = await executeWeatherTool(
			{ city: "Gimpo" },
			{
				fetch: async (u) =>
					u.includes("geocoding")
						? {
								ok: true,
								status: 200,
								json: async () => ({
									results: [
										{ name: "산", latitude: 1, longitude: 1, feature_code: "MT" },
										{ name: "김포", latitude: 37.6, longitude: 126.7, feature_code: "PPLA2" },
									],
								}),
							}
						: { ok: true, status: 200, json: async () => forecast },
			},
		);
		expect(r.output).toContain("김포");
	});
	it("인자가 없거나 네트워크 오류면 오류로 돌려준다", async () => {
		expect((await executeWeatherTool({})).isError).toBe(true);
		const r = await executeWeatherTool(
			{ latitude: 1, longitude: 2 },
			{ fetch: async () => { throw new Error("offline"); } },
		);
		expect(r.isError).toBe(true);
		expect(r.output).toContain("offline");
	});
	it("코드를 한국어로 푼다", () => {
		expect(describeWeatherCode(0)).toBe("맑음");
		expect(describeWeatherCode(999)).toContain("999");
	});
});
