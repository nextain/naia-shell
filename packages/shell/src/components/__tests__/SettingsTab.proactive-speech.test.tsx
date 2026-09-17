// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../lib/i18n";
import { ProactiveSpeechSettingsSection } from "../ProactiveSpeechSettingsSection";

afterEach(cleanup);

describe("PA-DJ-04 proactive settings UI", () => {
	it("keeps an active profile owned by the other settings section", async () => {
		await setLocale("en");
		const onSave = vi.fn(async () => true);
		render(
			<ProactiveSpeechSettingsSection
				mode="exhibition"
				value={{
					profile: "personal_radio_dj",
					timezone: "UTC",
					weatherConsented: false,
				}}
				onSave={onSave}
			/>,
		);

		expect(
			(screen.getByTestId("proactive-speech-profile") as HTMLSelectElement)
				.value,
		).toBe("disabled");
		expect(screen.queryByLabelText("Automatically play BGM")).toBeNull();
		fireEvent.click(screen.getByText("Save proactive speech settings"));
		await waitFor(() =>
			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({ profile: "personal_radio_dj" }),
			),
		);
	});

	it("shows DJ-only and exhibition-only fields in their owning sections", async () => {
		await setLocale("en");
		const value = {
			profile: "disabled" as const,
			timezone: "UTC",
			weatherConsented: false,
		};
		const dj = render(
			<ProactiveSpeechSettingsSection
				mode="dj"
				value={value}
				onSave={() => true}
			/>,
		);
		expect(screen.getByLabelText("Automatically play BGM")).toBeDefined();
		expect(screen.getByLabelText("Idle timeout (ms)")).toBeDefined();
		expect(screen.getByLabelText("DJ remark interval (ms)")).toBeDefined();
		expect(screen.getByLabelText("Use weather location")).toBeDefined();
		expect(screen.queryByLabelText("Exhibition knowledge scope")).toBeNull();
		dj.unmount();

		render(
			<ProactiveSpeechSettingsSection
				mode="exhibition"
				value={value}
				onSave={() => true}
			/>,
		);
		// #643: idle/interval/BGM/weather are Radio DJ-only — General (exhibition)
		// must not show them again, even though they live on the same shared config.
		expect(screen.queryByLabelText("Automatically play BGM")).toBeNull();
		expect(screen.queryByLabelText("Idle timeout (ms)")).toBeNull();
		expect(screen.queryByLabelText("DJ remark interval (ms)")).toBeNull();
		expect(screen.queryByLabelText("Use weather location")).toBeNull();
		expect(screen.queryByLabelText("Weather latitude")).toBeNull();
		expect(screen.queryByLabelText("Weather longitude")).toBeNull();
		expect(screen.getByLabelText("Exhibition knowledge scope")).toBeDefined();
	});

	it("fills an unconfigured DJ form with the Windows runtime defaults", async () => {
		await setLocale("en");
		const onSave = vi.fn(async () => true);
		render(
			<ProactiveSpeechSettingsSection
				mode="dj"
				value={{ profile: "disabled", timezone: "Asia/Seoul" }}
				onSave={onSave}
			/>,
		);

		expect(
			(screen.getByLabelText("Idle timeout (ms)") as HTMLInputElement).value,
		).toBe("120000");
		expect(
			(screen.getByLabelText("DJ remark interval (ms)") as HTMLInputElement)
				.value,
		).toBe("900000");
		expect(
			(screen.getByLabelText("Automatically play BGM") as HTMLInputElement)
				.checked,
		).toBe(false);
		fireEvent.click(screen.getByText("Save proactive speech settings"));
		await waitFor(() =>
			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					profile: "disabled",
					idleMs: 120_000,
					intervalMs: 900_000,
					bgmAutoPlay: false,
					weatherConsented: false,
				}),
			),
		);
	});

	it("keeps weather consent through an equivalent parent rerender", async () => {
		await setLocale("en");
		const value = {
			profile: "disabled" as const,
			timezone: "Asia/Seoul",
			weatherConsented: false,
		};
		const view = render(
			<ProactiveSpeechSettingsSection
				mode="dj"
				value={value}
				onSave={() => true}
			/>,
		);

		const consent = screen.getByTestId(
			"proactive-weather-consent",
		) as HTMLInputElement;
		fireEvent.click(consent);
		expect(consent.checked).toBe(true);

		view.rerender(
			<ProactiveSpeechSettingsSection
				mode="dj"
				value={{ ...value }}
				onSave={() => true}
			/>,
		);
		expect(
			(screen.getByTestId("proactive-weather-consent") as HTMLInputElement)
				.checked,
		).toBe(true);
	});
	it("edits and persists proactive speech settings", async () => {
		await setLocale("en");
		const onChange = vi.fn();
		const onSave = vi.fn(async () => true);
		const view = render(
			<ProactiveSpeechSettingsSection
				value={{
					profile: "disabled",
					timezone: "UTC",
					weatherConsented: false,
				}}
				onChange={onChange}
				onSave={onSave}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Proactive speech profile"), {
			target: { value: "personal_radio_dj" },
		});
		fireEvent.click(screen.getByLabelText("Use weather location"));
		fireEvent.change(screen.getByLabelText("Weather latitude"), {
			target: { value: "37.5665" },
		});
		fireEvent.change(screen.getByLabelText("Weather longitude"), {
			target: { value: "126.978" },
		});
		fireEvent.change(screen.getByLabelText("DJ remark interval (ms)"), {
			target: { value: "30000" },
		});
		fireEvent.change(screen.getByLabelText("Idle timeout (ms)"), {
			target: { value: "5000" },
		});
		fireEvent.change(screen.getByLabelText("Timezone"), {
			target: { value: "Asia/Seoul" },
		});
		fireEvent.click(screen.getByLabelText("Automatically play BGM"));
		fireEvent.change(screen.getByLabelText("Exhibition knowledge scope"), {
			target: { value: "expo-2026" },
		});
		fireEvent.click(screen.getByText("Save proactive speech settings"));
		await waitFor(() =>
			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({
					profile: "personal_radio_dj",
					weatherConsented: true,
					weatherLatitude: 37.5665,
					weatherLongitude: 126.978,
					intervalMs: 30000,
					idleMs: 5000,
					timezone: "Asia/Seoul",
					bgmAutoPlay: true,
					knowledgeScope: "expo-2026",
				}),
			),
		);
		view.unmount();
	});

	it("shows a fail-closed error when durable persistence fails", async () => {
		await setLocale("en");
		const view = render(
			<ProactiveSpeechSettingsSection
				value={{
					profile: "personal_radio_dj",
					timezone: "UTC",
					weatherConsented: true,
					weatherLatitude: 37,
					weatherLongitude: 127,
				}}
				onSave={async () => false}
			/>,
		);
		fireEvent.click(view.getByText("Save proactive speech settings"));
		expect(
			await view.findByTestId("proactive-settings-save-error"),
		).toHaveTextContent("proactive speech was safely blocked");
	});
});
