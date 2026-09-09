import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { test } from "node:test";

const { waitForPort } = await import("./wdio.conf.ts");

class FakeSocket extends EventEmitter {
	destroyed = false;

	destroy() {
		this.destroyed = true;
		return this;
	}
}

function rejectedConnector(sockets) {
	return (_port, _host) => {
		const socket = new FakeSocket();
		sockets.push(socket);
		queueMicrotask(() => socket.emit("error", new Error("ECONNREFUSED")));
		return socket;
	};
}

test("fails immediately on an ENOENT child and cancels port retries", async () => {
	const missingBinary = `/tmp/naia-e2e-missing-${process.pid}-${Date.now()}`;
	const child = spawn(missingBinary, []);
	const sockets = [];
	const startedAt = Date.now();

	await assert.rejects(
		waitForPort(
			49_991,
			30_000,
			{
				child,
				label: `native WebDriver/app (${missingBinary})`,
			},
			rejectedConnector(sockets),
		),
		(error) => {
			assert.match(error.message, /ENOENT/);
			assert.match(error.message, new RegExp(missingBinary.replaceAll("/", "\\/")));
			return true;
		},
	);

	assert.ok(Date.now() - startedAt < 2_000);
	assert.equal(sockets.length, 3);
	assert.ok(sockets.every((socket) => socket.destroyed));
	await new Promise((resolve) => setTimeout(resolve, 600));
	assert.equal(sockets.length, 3, "child failure must cancel the 500ms retry");
});

test("fails immediately when an owned child exits before readiness", async () => {
	const child = spawn(process.execPath, ["-e", "process.exit(23)"]);
	const sockets = [];
	const startedAt = Date.now();

	await assert.rejects(
		waitForPort(
			49_993,
			30_000,
			{ child, label: "native WebDriver/app (exiting test child)" },
			rejectedConnector(sockets),
		),
		(error) => {
			assert.match(error.message, /exited before readiness/);
			assert.match(error.message, /code=23/);
			return true;
		},
	);

	assert.ok(Date.now() - startedAt < 2_000);
	assert.equal(sockets.length, 3);
	assert.ok(sockets.every((socket) => socket.destroyed));
});

test("keeps one owned child alive when the port probe succeeds", async () => {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
	const sockets = [];

	try {
		await waitForPort(
			49_992,
			1_000,
			{ child, label: "native WebDriver/app (test child)" },
			(_port, _host) => {
				const socket = new FakeSocket();
				sockets.push(socket);
				queueMicrotask(() => socket.emit("connect"));
				return socket;
			},
		);

		assert.equal(child.exitCode, null);
		assert.equal(sockets.length, 3);
		assert.ok(sockets.every((socket) => socket.destroyed));
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill();
		if (child.exitCode === null && child.signalCode === null) {
			await once(child, "exit");
		}
	}
});
