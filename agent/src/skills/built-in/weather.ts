import { weatherDescriptor } from "@naia-adk/skills-builtin";
import type { SkillDefinition } from "../types.js";

export function createWeatherSkill(): SkillDefinition {
	return {
		name: `skill_${weatherDescriptor.name}`,
		description: weatherDescriptor.description,
		parameters: weatherDescriptor.inputSchema,
		tier: 0,
		requiresGateway: false,
		source: "built-in",
		execute: async (args) => {
			const location = args.location as string | undefined;
			if (!location?.trim()) {
				return {
					success: false,
					output: "",
					error: "location is required",
				};
			}

			try {
				const url = `https://wttr.in/${encodeURIComponent(location.trim())}?format=j1`;
				const res = await fetch(url, {
					headers: { "User-Agent": "Naia-OS/1.0" },
					signal: AbortSignal.timeout(10_000),
				});

				if (!res.ok) {
					return {
						success: false,
						output: "",
						error: `Weather API returned ${res.status}`,
					};
				}

				const data = (await res.json()) as {
					current_condition?: Array<{
						temp_C?: string;
						temp_F?: string;
						weatherDesc?: Array<{ value?: string }>;
						humidity?: string;
						windspeedKmph?: string;
						winddir16Point?: string;
						FeelsLikeC?: string;
						uvIndex?: string;
					}>;
					nearest_area?: Array<{
						areaName?: Array<{ value?: string }>;
						country?: Array<{ value?: string }>;
					}>;
				};

				const current = data.current_condition?.[0];
				if (!current) {
					return {
						success: false,
						output: "",
						error: "No weather data available for this location",
					};
				}

				const area = data.nearest_area?.[0];
				const result = {
					location: area?.areaName?.[0]?.value ?? location,
					country: area?.country?.[0]?.value ?? "",
					temperature: `${current.temp_C}°C (${current.temp_F}°F)`,
					feelsLike: `${current.FeelsLikeC}°C`,
					condition: current.weatherDesc?.[0]?.value ?? "Unknown",
					humidity: `${current.humidity}%`,
					wind: `${current.windspeedKmph} km/h ${current.winddir16Point}`,
					uvIndex: current.uvIndex ?? "N/A",
				};

				return {
					success: true,
					output: JSON.stringify(result),
				};
			} catch (err) {
				return {
					success: false,
					output: "",
					error: `Weather failed: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
		},
	};
}
