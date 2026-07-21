import {
	type CodingWorkersAdapter,
	unavailableCodingWorkersAdapter,
} from "./coding-workers";

export type CodingWorkersAdapterFactory = () => CodingWorkersAdapter;

// The Rust/Tauri bridge replaces this factory after the paired Agent proto is
// available. Keeping the unavailable adapter here, outside the panel, makes
// the boundary explicit and prevents UI-only success states.
let adapterFactory: CodingWorkersAdapterFactory = () =>
	unavailableCodingWorkersAdapter;

export function getCodingWorkersAdapter(): CodingWorkersAdapter {
	return adapterFactory();
}

export function setCodingWorkersAdapterFactory(
	factory: CodingWorkersAdapterFactory,
): void {
	adapterFactory = factory;
}
