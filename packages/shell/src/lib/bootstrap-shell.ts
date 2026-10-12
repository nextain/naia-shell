interface BootstrapShellDependencies {
	initializeI18n: () => Promise<void>;
	renderApp: () => void;
	afterRender?: () => void;
	registerProjectApp: () => Promise<unknown>;
	onProjectRegistrationFailure: (error: unknown) => void;
}

export async function bootstrapShell({
	initializeI18n,
	renderApp,
	afterRender,
	registerProjectApp,
	onProjectRegistrationFailure,
}: BootstrapShellDependencies): Promise<void> {
	await initializeI18n();
	renderApp();
	afterRender?.();
	try {
		await registerProjectApp();
	} catch (error) {
		onProjectRegistrationFailure(error);
	}
}
