export function interpolateMessage(
	template: string,
	values: Readonly<Record<string, string | number>>,
): string {
	return template.replace(/\{(\w+)\}/g, (placeholder, key) =>
		Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : placeholder,
	);
}
