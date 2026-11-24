// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../lib/i18n";
import { Directory, WorkspaceMusicPreview } from "../WebWorkspace";

const readState = vi.hoisted(() => ({ failPreview: true }));

vi.mock("../../../lib/web-runtime/web-bgm-music", async (importOriginal) => {
	const mod =
		await importOriginal<typeof import("../../../lib/web-runtime/web-bgm-music")>();
	return {
		...mod,
		readWebBgmMusicBlob: async () => {
			if (readState.failPreview)
				throw new DOMException("No access", "NotAllowedError");
			return new Blob(["audio"], { type: "audio/wav" });
		},
	};
});

describe("web workspace recovery affordance", () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("offers retry when directory listing fails and recovers on retry", async () => {
		await setLocale("ko");
		let failListing = true;
		const dir = {
			kind: "directory",
			name: "work",
			async *values() {
				if (failListing) throw new DOMException("No access", "NotAllowedError");
				yield { kind: "file", name: "a.txt" };
			},
		} as unknown as FileSystemDirectoryHandle;
		render(
			<Directory
				dir={dir}
				path="opfs://naia-adk/work"
				onOpen={() => {}}
				treeRevision={0}
			/>,
		);
		expect(await screen.findByRole("alert")).toBeInTheDocument();
		const retry = await screen.findByRole("button", { name: "다시 시도" });
		failListing = false;
		fireEvent.click(retry);
		expect(await screen.findByRole("button", { name: /a\.txt/ })).toBeVisible();
	});

	it("offers retry when preview audio fails and recovers on retry", async () => {
		await setLocale("ko");
		readState.failPreview = true;
		vi.stubGlobal("URL", class extends URL {
			static createObjectURL = vi.fn(() => "blob:preview-test");
			static revokeObjectURL = vi.fn();
		});
		render(
			<WorkspaceMusicPreview
				path="opfs://naia-adk/bgm-musics/song.wav"
				name="song.wav"
			/>,
		);
		expect(await screen.findByRole("alert")).toBeInTheDocument();
		const retry = await screen.findByRole("button", { name: "다시 시도" });
		readState.failPreview = false;
		fireEvent.click(retry);
		await waitFor(() =>
			expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
		);
	});
});
