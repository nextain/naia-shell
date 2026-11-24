// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_APP_STORAGE_VALUE_CHARS } from "../../generic-installed/installed-app-storage";
import { parseCharacterCardJsonText } from "../card-parser";
import {
	CHARCARD_DB_NAME,
	CardStorageValueTooLargeError,
	type StoredCardRecord,
	createCardStorage,
} from "../card-store";

type StorageRequest = {
	type: string;
	appId: string;
	id: string;
	op: string;
	key: string;
	value?: unknown;
};

function shellStorageHost(
	reply: (request: StorageRequest) => object | undefined,
) {
	const iframe = document.createElement("iframe");
	document.body.append(iframe);
	const parent = iframe.contentWindow!;
	vi.spyOn(window, "parent", "get").mockReturnValue(parent);
	return vi.spyOn(parent, "postMessage").mockImplementation((message) => {
		const request = message as StorageRequest;
		const result = reply(request);
		if (!result) return;
		window.dispatchEvent(
			new MessageEvent("message", {
				source: parent,
				origin: window.location.origin,
				data: { type: "naia-app:storage-result", id: request.id, ...result },
			}),
		);
	});
}

function cardRecord(id: string, importedAt = 1): StoredCardRecord {
	const result = parseCharacterCardJsonText(
		JSON.stringify({ name: id, first_mes: "Hello" }),
	);
	if (!result.ok) throw new Error("Invalid test card");
	return {
		id,
		fileName: `${id}.json`,
		importedAt,
		card: result.card,
		rawJson: result.card.rawJson,
		imageBlob: null,
	};
}

function blockCardDatabase() {
	vi.stubGlobal("indexedDB", {
		open: () => {
			throw new DOMException("Opaque origin", "SecurityError");
		},
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	document.body.replaceChildren();
});

describe("R11 character card storage", () => {
	it("uses the existing local IndexedDB when it can open", async () => {
		const post = shellStorageHost(() => ({ ok: true, keys: [] }));
		const request = { result: {} as IDBDatabase, onsuccess: () => {} };
		const open = vi.fn(() => {
			queueMicrotask(() => request.onsuccess());
			return request;
		});
		vi.stubGlobal("indexedDB", { open });
		expect((await createCardStorage()).mode).toBe("indexeddb");
		expect(open).toHaveBeenCalledWith(CHARCARD_DB_NAME, 1);
		expect(post).not.toHaveBeenCalled();
	});

	it("saves, reloads and deletes cards and their images through the shell", async () => {
		blockCardDatabase();
		const records = new Map<string, unknown>();
		const post = shellStorageHost(({ op, key, value }) => {
			switch (op) {
				case "keys":
					return { ok: true, keys: ["other-data", ...records.keys()] };
				case "get":
					return { ok: true, value: records.get(key) ?? null };
				case "set":
					records.set(key, value);
					return { ok: true };
				case "delete":
					records.delete(key);
					return { ok: true };
			}
		});
		const store = await createCardStorage();
		expect(store.mode).toBe("host");
		expect(post).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "naia-app:storage",
				appId: "land.naia.charcard",
				op: "keys",
			}),
			window.location.origin,
		);
		const older = cardRecord("older");
		const newer = {
			...cardRecord("newer", 2),
			imageBlob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
		};
		await store.saveCard(older);
		await store.saveCard(newer);
		expect(records.get("card:newer")).toEqual({
			...newer,
			imageBlob: "data:image/png;base64,AQID",
		});
		const reopened = await createCardStorage();
		const [loaded, earlier] = await reopened.listCards();
		expect(earlier).toEqual(older);
		expect({ ...loaded, imageBlob: null }).toEqual({
			...newer,
			imageBlob: null,
		});
		expect(loaded.imageBlob).toBeInstanceOf(Blob);
		expect(loaded.imageBlob).toMatchObject({ type: "image/png", size: 3 });
		await reopened.removeCard(newer.id);
		expect(await store.listCards()).toEqual([older]);
	});

	it("uses memory when the shell refuses storage", async () => {
		blockCardDatabase();
		shellStorageHost(() => ({ ok: false, error: "unavailable" }));
		const store = await createCardStorage();
		expect(store.mode).toBe("memory");
		const record = cardRecord("temporary");
		await store.saveCard(record);
		expect(await store.listCards()).toEqual([record]);
		expect(await (await createCardStorage()).listCards()).toEqual([]);
	});

	it("uses memory when the parent never answers", async () => {
		vi.useFakeTimers();
		blockCardDatabase();
		shellStorageHost(() => undefined);
		const opening = createCardStorage();
		await vi.runAllTimersAsync();
		expect((await opening).mode).toBe("memory");
	});

	it("rejects values beyond the shell limit before posting them", async () => {
		blockCardDatabase();
		const post = shellStorageHost(() => ({ ok: true, keys: [] }));
		const store = await createCardStorage();
		const record = cardRecord("oversized");
		const imageBlob = new Blob(
			[new Uint8Array((MAX_APP_STORAGE_VALUE_CHARS * 3) / 4 + 1)],
			{ type: "image/png" },
		);
		await expect(
			store.saveCard({ ...record, imageBlob }),
		).rejects.toBeInstanceOf(CardStorageValueTooLargeError);
		await expect(
			store.saveCard({
				...record,
				rawJson: { long: "x".repeat(MAX_APP_STORAGE_VALUE_CHARS) },
			}),
		).rejects.toBeInstanceOf(CardStorageValueTooLargeError);
		expect(post).not.toHaveBeenCalledWith(
			expect.objectContaining({ op: "set" }),
			expect.anything(),
		);
		expect(await store.listCards()).toEqual([]);
	});
});
