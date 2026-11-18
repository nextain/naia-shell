/** Select the Cafe Lua lounge for the user's local date and time. */
export function loungeBackground(date: Date): string {
	const month = date.getMonth() + 1;
	const season =
		month >= 3 && month <= 5
			? "spring"
			: month <= 8 && month >= 6
				? "summer"
				: month >= 9 && month <= 11
					? "autumn"
					: "winter";
	const hour = date.getHours();
	const time =
		hour >= 6 && hour <= 16
			? "day_sunny"
			: hour >= 17 && hour <= 18
				? "sunset_clear"
				: "night_closed";
	return `lounge-background-img/lounge_bg_${season}_${time}.webp`;
}
