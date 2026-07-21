// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { setLocale } from "../../lib/i18n";
import { ProactiveSpeechSettingsSection } from "../ProactiveSpeechSettingsSection";

describe("PA-DJ-04 proactive settings UI", () => {
	it("edits and persists proactive speech settings", async () => {
		setLocale("en");
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
		setLocale("en");
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
