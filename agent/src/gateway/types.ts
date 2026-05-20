/** Abstract interface for any gateway implementation */
export interface GatewayAdapter {
	request(method: string, params: unknown): Promise<unknown>;
	onEvent(handler: (event: GatewayEvent) => void): void;
	offEvent(handler: (event: GatewayEvent) => void): void;
	close(): void;
	isConnected(): boolean;
	readonly availableMethods: string[];
}

/** Gateway WebSocket protocol frame types */

export interface GatewayRequest {
	type: "req";
	id: string;
	method: string;
	params: unknown;
}

export interface GatewayResponseOk {
	type: "res";
	id: string;
	ok: true;
	payload: unknown;
}

export interface GatewayResponseError {
	type: "res";
	id: string;
	ok: false;
	error: { code: string; message: string };
}

export type GatewayResponse = GatewayResponseOk | GatewayResponseError;

export interface GatewayEvent {
	type: "event" | "evt";
	event: string;
	payload?: unknown;
	seq?: number;
}

export type GatewayFrame = GatewayRequest | GatewayResponse | GatewayEvent;

/** Result from command execution via CommandExecutor. */
export interface CommandResult {
	success: boolean;
	output: string;
	error?: string;
}

/** Options for CommandExecutor.execute() */
export interface CommandExecuteOptions {
	/** Working directory for the command. */
	cwd?: string;
}

/** Abstract interface for executing shell commands. */
export interface CommandExecutor {
	execute(
		command: string,
		options?: CommandExecuteOptions,
	): Promise<CommandResult>;
}

/**
 * Resolves platform-specific paths for Gateway configuration and identity.
 * All user-data paths resolve under naia-settings/ when NAIA_SETTINGS_DIR
 * is set (written by the shell via write_naia_path_cache), falling back to
 * ~/.naia/ for standalone / first-run scenarios.
 */
export interface PathResolver {
	/** Path to device identity JSON file. */
	deviceIdentityPath(): string;
	/** Ordered candidate paths for Gateway config (first match wins). */
	configCandidates(): string[];
	/** Path to memory-specific config (separate from gateway config). */
	memoryConfigPath(): string;
	/** Path to the SQLite memory database. */
	memoryDbPath(): string;
	/** Directory where local session JSON files are stored. */
	sessionsPath(): string;
	/** Directory containing device identity files. */
	identityDirPath(): string;
	/** Directory where offline embedding model files are cached. */
	embeddingModelsPath(): string;
}

/** Device identity for Gateway authentication */
export interface DeviceIdentity {
	id: string;
	publicKey: string;
	privateKeyPem: string;
}

/** Options for GatewayClient.connect() */
export interface GatewayConnectOptions {
	token: string;
	clientId?: string;
	platform?: string;
	mode?: string;
	version?: string;
	role?: string;
	scopes?: string[];
	device?: DeviceIdentity;
}
