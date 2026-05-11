// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SplashScreen } from "../SplashScreen";

describe("SplashScreen", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("does not call onDone before minDuration even if ready=true", () => {
		const onDone = vi.fn();
		render(<SplashScreen onDone={onDone} ready={true} minDuration={2000} />);
		act(() => vi.advanceTimersByTime(1500));
		expect(onDone).not.toHaveBeenCalled();
	});

	it("calls onDone after minDuration + fade when ready=true", () => {
		const onDone = vi.fn();
		render(<SplashScreen onDone={onDone} ready={true} minDuration={2000} />);
		// Step 1: advance past minDuration so minElapsed flips to true and
		// React re-renders (triggering the second useEffect).
		act(() => vi.advanceTimersByTime(2001));
		// Step 2: the second effect created a 500 ms fade timer — advance past it.
		act(() => vi.advanceTimersByTime(600));
		expect(onDone).toHaveBeenCalledOnce();
	});

	it("does not call onDone when minDuration elapsed but ready=false", () => {
		const onDone = vi.fn();
		render(<SplashScreen onDone={onDone} ready={false} minDuration={2000} />);
		act(() => vi.advanceTimersByTime(2001));
		act(() => vi.advanceTimersByTime(600));
		expect(onDone).not.toHaveBeenCalled();
	});

	it("calls onDone after ready fires (minDuration already elapsed)", () => {
		const onDone = vi.fn();
		const { rerender } = render(
			<SplashScreen onDone={onDone} ready={false} minDuration={500} />,
		);
		// Let minDuration pass; ready=false so no fade yet
		act(() => vi.advanceTimersByTime(600));
		expect(onDone).not.toHaveBeenCalled();
		// Signal ready — effect fires, creates 500 ms fade timer
		rerender(<SplashScreen onDone={onDone} ready={true} minDuration={500} />);
		act(() => vi.advanceTimersByTime(600));
		expect(onDone).toHaveBeenCalledOnce();
	});

	it("renders splash content", () => {
		render(<SplashScreen onDone={vi.fn()} ready={true} />);
		// "Naia" brand text should be present in the logo area
		const el = document.querySelector(".splash-logo-text");
		expect(el?.textContent).toBe("Naia");
	});

	it("starts fading after minDuration when ready=true", () => {
		render(<SplashScreen onDone={vi.fn()} ready={true} minDuration={1000} />);
		// Before minDuration: no fade
		expect(document.querySelector(".splash-screen--fade")).toBeNull();
		// Advance past minDuration; flush two render cycles (minElapsed→fading)
		act(() => vi.advanceTimersByTime(1001));
		act(() => vi.advanceTimersByTime(0));
		// After minDuration + React flush: fading class should be present
		expect(document.querySelector(".splash-screen--fade")).not.toBeNull();
	});
});
