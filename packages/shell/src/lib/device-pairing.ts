import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const STORE_FILE = "device-pairings.json";
const STORE_VERSION = 1;
const PAIR_TTL_SECS = 600;

export type PairStatus = "pending" | "verified" | "approved" | "rejected";

export interface NodePublic {
	nodeId: string;
	displayName: string;
	platform: string;
	createdAt: number;
	lastSeen?: number;
	hasToken: boolean;
}

export interface PairRequestPublic {
	requestId: string;
	nodeId: string;
	displayName: string;
	platform: string;
	status: PairStatus;
	createdAt: number;
	expiresAt: number;
}

interface NodeRecord {
	nodeId: string;
	displayName: string;
	platform: string;
	tokenHash?: string;
	createdAt: number;
	lastSeen?: number;
}

interface PairRequestRecord {
	requestId: string;
	nodeId: string;
	displayName: string;
	platform: string;
	codeHash: string;
	status: PairStatus;
	createdAt: number;
	expiresAt: number;
}

interface PairingStore {
	version: number;
	nodes: NodeRecord[];
	requests: PairRequestRecord[];
}

function nowSecs(): number {
	return Math.floor(Date.now() / 1000);
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function randomHex(bytes: number): string {
	return randomBytes(bytes).toString("hex");
}

function emptyStore(): PairingStore {
	return { version: STORE_VERSION, nodes: [], requests: [] };
}

export function storePathForAdk(adkPath: string): string {
	return join(adkPath, STORE_FILE);
}

function loadStore(path: string): PairingStore {
	try {
		const raw = readFileSync(path, "utf8");
		if (!raw.trim()) return emptyStore();
		return JSON.parse(raw) as PairingStore;
	} catch {
		return emptyStore();
	}
}

function saveStore(path: string, store: PairingStore): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`);
}

function nodePublic(node: NodeRecord): NodePublic {
	return {
		nodeId: node.nodeId,
		displayName: node.displayName,
		platform: node.platform,
		createdAt: node.createdAt,
		lastSeen: node.lastSeen,
		hasToken: Boolean(node.tokenHash),
	};
}

export function pairRequest(
	path: string,
	displayName: string,
	platform: string,
): { request: PairRequestPublic; code: string } {
	const name = displayName.trim();
	if (!name) throw new Error("display_name_required");
	const now = nowSecs();
	const code = randomHex(3);
	const request: PairRequestRecord = {
		requestId: randomHex(16),
		nodeId: randomHex(16),
		displayName: name,
		platform: platform.trim() || "unknown",
		codeHash: sha256Hex(code),
		status: "pending",
		createdAt: now,
		expiresAt: now + PAIR_TTL_SECS,
	};
	const store = loadStore(path);
	store.requests.push(request);
	saveStore(path, store);
	return {
		request: {
			requestId: request.requestId,
			nodeId: request.nodeId,
			displayName: request.displayName,
			platform: request.platform,
			status: request.status,
			createdAt: request.createdAt,
			expiresAt: request.expiresAt,
		},
		code,
	};
}

export function pairVerify(
	path: string,
	requestId: string,
	code: string,
): PairRequestPublic {
	const now = nowSecs();
	const store = loadStore(path);
	const request = store.requests.find((item) => item.requestId === requestId);
	if (!request) throw new Error("request_not_found");
	if (request.expiresAt < now) throw new Error("request_expired");
	if (request.status !== "pending") throw new Error("request_not_pending");
	if (request.codeHash !== sha256Hex(code.trim())) throw new Error("code_mismatch");
	request.status = "verified";
	saveStore(path, store);
	return {
		requestId: request.requestId,
		nodeId: request.nodeId,
		displayName: request.displayName,
		platform: request.platform,
		status: request.status,
		createdAt: request.createdAt,
		expiresAt: request.expiresAt,
	};
}

export function pairApprove(
	path: string,
	requestId: string,
): { node: NodePublic; token: string } {
	const now = nowSecs();
	const store = loadStore(path);
	const request = store.requests.find((item) => item.requestId === requestId);
	if (!request) throw new Error("request_not_found");
	if (request.expiresAt < now) throw new Error("request_expired");
	if (request.status !== "verified") throw new Error("request_not_verified");
	request.status = "approved";
	const token = randomHex(32);
	const node: NodeRecord = {
		nodeId: request.nodeId,
		displayName: request.displayName,
		platform: request.platform,
		tokenHash: sha256Hex(token),
		createdAt: now,
		lastSeen: now,
	};
	store.nodes.push(node);
	saveStore(path, store);
	return { node: nodePublic(node), token };
}

export function rotateToken(path: string, nodeId: string): string {
	const store = loadStore(path);
	const node = store.nodes.find((item) => item.nodeId === nodeId);
	if (!node) throw new Error("node_not_found");
	const token = randomHex(32);
	node.tokenHash = sha256Hex(token);
	saveStore(path, store);
	return token;
}

export function revokeToken(path: string, nodeId: string): NodePublic {
	const store = loadStore(path);
	const node = store.nodes.find((item) => item.nodeId === nodeId);
	if (!node) throw new Error("node_not_found");
	node.tokenHash = undefined;
	saveStore(path, store);
	return nodePublic(node);
}

export function authenticate(path: string, nodeId: string, token: string): boolean {
	const store = loadStore(path);
	const node = store.nodes.find((item) => item.nodeId === nodeId);
	return Boolean(node?.tokenHash && node.tokenHash === sha256Hex(token));
}

export function describeNode(path: string, nodeId: string): NodePublic {
	const store = loadStore(path);
	const node = store.nodes.find((item) => item.nodeId === nodeId);
	if (!node) throw new Error("node_not_found");
	return nodePublic(node);
}

export function renameNode(
	path: string,
	nodeId: string,
	displayName: string,
): NodePublic {
	const name = displayName.trim();
	if (!name) throw new Error("display_name_required");
	const store = loadStore(path);
	const node = store.nodes.find((item) => item.nodeId === nodeId);
	if (!node) throw new Error("node_not_found");
	node.displayName = name;
	saveStore(path, store);
	return nodePublic(node);
}
