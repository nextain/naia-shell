// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearCameraActions,
	registerCameraActions,
} from "../../lib/avatar/camera-actions";
import { useCascadeAvatarStore } from "../../stores/cascade-avatar";
import { NvaGestureActions } from "../NvaGestureActions";

describe("NvaGestureActions", () => {
	beforeEach(() => {
		useCascadeAvatarStore.getState().setRenderer(null);
		clearCameraActions();
	});

	afterEach(() => {
		cleanup();
		useCascadeAvatarStore.getState().setRenderer(null);
		clearCameraActions();
	});

	it("places accessible action buttons directly beside the chat input", () => {
		registerCameraActions({
			getGestureActions: () => [
				{ key: "wave", label: "Welcome" },
				{ key: "cheer", label: "Starry cheer" },
			],
		});
		useCascadeAvatarStore.getState().setRenderer({} as never);
		const { container } = render(
			<div className="chat-column">
				<NvaGestureActions />
				<div className="chat-input-bar" />
			</div>,
		);

		const group = screen.getByRole("group", { name: "Avatar gestures" });
		const inputBar = container.querySelector(".chat-input-bar");
		expect(group.parentElement).toBe(inputBar?.parentElement);
		expect(group.compareDocumentPosition(inputBar!)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
		const welcome = screen.getByRole("button", { name: "Welcome (Alt+1)" });
		expect(welcome.getAttribute("title")).toBe("Welcome (Alt+1)");
		expect(
			screen.getByRole("button", { name: "Starry cheer (Alt+2)" }),
		).toBeDefined();
	});

	it("records and plays a manual action", () => {
		const playAction = vi.fn().mockResolvedValue(undefined);
		const onManualAction = vi.fn();
		registerCameraActions({
			getGestureActions: () => [{ key: "wave", label: "Welcome" }],
			playAction,
		});
		useCascadeAvatarStore.getState().setRenderer({} as never);
		render(<NvaGestureActions onManualAction={onManualAction} />);

		fireEvent.click(screen.getByRole("button", { name: "Welcome (Alt+1)" }));
		expect(onManualAction).toHaveBeenCalledWith("wave");
		expect(playAction).toHaveBeenCalledWith("wave");
	});

	it("updates the action list when the active renderer changes", () => {
		registerCameraActions({
			getGestureActions: () => [{ key: "wave", label: "Welcome" }],
		});
		useCascadeAvatarStore.getState().setRenderer({} as never);
		render(<NvaGestureActions />);
		expect(
			screen.getByRole("button", { name: "Welcome (Alt+1)" }),
		).toBeDefined();

		act(() => {
			registerCameraActions({
				getGestureActions: () => [{ key: "cheer", label: "Starry cheer" }],
			});
			useCascadeAvatarStore.getState().setRenderer({} as never);
		});
		expect(screen.queryByRole("button", { name: /Welcome/ })).toBeNull();
		expect(
			screen.getByRole("button", { name: "Starry cheer (Alt+1)" }),
		).toBeDefined();
	});

	it("renders nothing for a non-NVA renderer or an empty action list", () => {
		registerCameraActions({ getGestureActions: () => [] });
		useCascadeAvatarStore.getState().setRenderer({} as never);
		const { rerender } = render(<NvaGestureActions />);
		expect(screen.queryByTestId("nva-gesture-actions")).toBeNull();

		useCascadeAvatarStore.getState().setRenderer(null);
		rerender(<NvaGestureActions />);
		expect(screen.queryByTestId("nva-gesture-actions")).toBeNull();
	});
});
