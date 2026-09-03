// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { lazy } from "react";
import { describe, expect, it, vi } from "vitest";
import { LazyPanel } from "../LazyPanel";

function LoadedPanel({ label }: { label: string }) {
	return <div>{label}</div>;
}

describe("LazyPanel", () => {
	it("shows an accessible loading status before the panel resolves", async () => {
		let resolve!: (module: { default: typeof LoadedPanel }) => void;
		const load = vi.fn(
			() =>
				new Promise<{ default: typeof LoadedPanel }>((done) => {
					resolve = done;
				}),
		);

		render(
			<LazyPanel<{ label: string }>
				component={lazy(load)}
				renderComponent={(Panel) => <Panel label="ready" />}
				loadingLabel="Loading panel…"
				errorLabel="Panel unavailable"
			/>,
		);

		expect(screen.getByText("Loading panel…")).toBeInTheDocument();
		resolve({ default: LoadedPanel });
		expect(await screen.findByText("ready")).toBeInTheDocument();
	});

	it("contains a rejected panel without unmounting sibling content", async () => {
		const FailedPanel = lazy(() =>
			Promise.reject(new Error("chunk unavailable")),
		);
		render(
			<div>
				<span>preserved sibling</span>
				<LazyPanel
					component={FailedPanel}
					renderComponent={(Panel) => <Panel />}
					loadingLabel="Loading panel…"
					errorLabel="Panel unavailable"
				/>
			</div>,
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Panel unavailable",
		);
		expect(screen.getByText("preserved sibling")).toBeInTheDocument();
	});
});
