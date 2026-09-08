#!/usr/bin/env node

/**
 * Stable, human-friendly labels for QA cases.
 *
 * QC numbers are presentation metadata.  They deliberately live in a
 * selected ADK sidecar instead of the catalog or round manifest so adding a
 * label cannot change a frozen catalog hash, round snapshot, or result.
 */

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const QC_NUMBER_VERSION = 1;
export const QC_NUMBER_SCHEMA = "naia-shell.qa-qc-numbers.v1";
export const QC_NUMBER_FILE = "qc-numbers.json";

class QcNumberError extends Error {
	constructor(message) {
		super(`[qa-qc-numbers] ${message}`);
		this.name = "QcNumberError";
	}
}

function fail(message) {
	throw new QcNumberError(message);
}

function nonEmptyString(value, label) {
	if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string`);
	return value.trim();
}

function requireAbsolutePath(value, label) {
	const candidate = nonEmptyString(value, label);
	if (!isAbsolute(candidate)) fail(`${label} must be an absolute path`);
	return resolve(candidate);
}

function normalizeCaseIds(value) {
	if (!Array.isArray(value)) fail("caseIds must be an array");
	const caseIds = value.map((entry, index) => nonEmptyString(entry, `caseIds[${index}]`));
	if (new Set(caseIds).size !== caseIds.length) fail("caseIds contains duplicates");
	return caseIds;
}

function qcLabel(number) {
	return `QC-${String(number).padStart(3, "0")}`;
}

function parseQcLabel(value, label) {
	const raw = nonEmptyString(value, label);
	const match = /^QC-(\d{3,})$/.exec(raw);
	if (!match) fail(`${label} must match QC-NNN`);
	const number = Number(match[1]);
	if (!Number.isSafeInteger(number) || number < 1) fail(`${label} must contain a positive safe integer`);
	return { label: raw, number };
}

function validateSidecar(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail("sidecar must be an object");
	if (value.schema !== QC_NUMBER_SCHEMA) fail(`sidecar.schema must be ${QC_NUMBER_SCHEMA}`);
	if (value.version !== QC_NUMBER_VERSION) fail(`sidecar.version must be ${QC_NUMBER_VERSION}`);
	if (!Number.isSafeInteger(value.nextNumber) || value.nextNumber < 1) fail("sidecar.nextNumber must be a positive safe integer");
	if (!Array.isArray(value.assignments)) fail("sidecar.assignments must be an array");

	const caseIds = new Set();
	const qcNumbers = new Set();
	let highest = 0;
	const assignments = value.assignments.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`sidecar.assignments[${index}] must be an object`);
		const caseId = nonEmptyString(entry.caseId, `sidecar.assignments[${index}].caseId`);
		const parsed = parseQcLabel(entry.qcNumber, `sidecar.assignments[${index}].qcNumber`);
		if (caseIds.has(caseId)) fail(`sidecar repeats caseId: ${caseId}`);
		if (qcNumbers.has(parsed.number)) fail(`sidecar repeats qcNumber: ${parsed.label}`);
		caseIds.add(caseId);
		qcNumbers.add(parsed.number);
		highest = Math.max(highest, parsed.number);
		return { caseId, qcNumber: parsed.label };
	});
	if (value.nextNumber <= highest) fail("sidecar.nextNumber must be greater than every assigned number");
	return {
		schema: QC_NUMBER_SCHEMA,
		version: QC_NUMBER_VERSION,
		nextNumber: value.nextNumber,
		assignments,
	};
}

function sidecarFromAssignments(assignments, nextNumber) {
	return validateSidecar({
		schema: QC_NUMBER_SCHEMA,
		version: QC_NUMBER_VERSION,
		nextNumber,
		assignments,
	});
}

function projectAssignments(caseIds, current) {
	const normalizedCaseIds = normalizeCaseIds(caseIds);
	const existing = current ? validateSidecar(current) : sidecarFromAssignments([], 1);
	const assignedByCaseId = new Map(existing.assignments.map((entry) => [entry.caseId, entry.qcNumber]));
	let nextNumber = existing.nextNumber;
	const assignments = [...existing.assignments];
	for (const caseId of normalizedCaseIds) {
		if (assignedByCaseId.has(caseId)) continue;
		const qcNumber = qcLabel(nextNumber);
		nextNumber += 1;
		assignedByCaseId.set(caseId, qcNumber);
		assignments.push({ caseId, qcNumber });
	}
	return sidecarFromAssignments(assignments, nextNumber);
}

function resultFor(sidecar, targetPath, changed) {
	return {
		path: targetPath ?? null,
		...sidecar,
		byCaseId: new Map(sidecar.assignments.map((entry) => [entry.caseId, entry.qcNumber])),
		changed,
	};
}

function writeJsonAtomic(filePath, value) {
	mkdirSync(dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
	writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
	renameSync(temporaryPath, filePath);
}

function withSidecarLock(filePath, callback) {
	const lockPath = `${filePath}.lock`;
	mkdirSync(dirname(filePath), { recursive: true });
	let fd;
	try {
		fd = openSync(lockPath, "wx", 0o600);
	} catch (error) {
		if (error?.code === "EEXIST") fail(`sidecar lock is held: ${lockPath}`);
		throw error;
	}
	try {
		return callback();
	} finally {
		closeSync(fd);
		try {
			unlinkSync(lockPath);
		} catch {
			// Preserve the callback result; the lock owner has already closed its fd.
		}
	}
}

function readJson(filePath) {
	try {
		return JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		fail(`invalid sidecar ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function targetPathFor({ adkPath, mapPath } = {}) {
	if (mapPath !== undefined) return requireAbsolutePath(mapPath, "mapPath");
	if (adkPath !== undefined) return join(requireAbsolutePath(adkPath, "adkPath"), "qa", QC_NUMBER_FILE);
	return null;
}

export function qcNumberMapPath(adkPath) {
	return targetPathFor({ adkPath });
}

export function readQcNumberMap({ adkPath, mapPath } = {}) {
	const targetPath = targetPathFor({ adkPath, mapPath });
	if (!targetPath) fail("adkPath or mapPath is required");
	if (!existsSync(targetPath)) return null;
	return resultFor(validateSidecar(readJson(targetPath)), targetPath, false);
}

/**
 * Project case IDs into a sidecar. Existing assignments are retained in their
 * original order; only new case IDs append new numbers.
 */
export function ensureQcNumbers({ adkPath, mapPath, caseIds } = {}) {
	const normalizedCaseIds = normalizeCaseIds(caseIds);
	const targetPath = targetPathFor({ adkPath, mapPath });
	if (!targetPath) return resultFor(projectAssignments(normalizedCaseIds), null, false);
	return withSidecarLock(targetPath, () => {
		const existing = existsSync(targetPath) ? validateSidecar(readJson(targetPath)) : null;
		const projected = projectAssignments(normalizedCaseIds, existing);
		const changed = JSON.stringify(existing) !== JSON.stringify(projected);
		if (changed) writeJsonAtomic(targetPath, projected);
		return resultFor(projected, targetPath, changed);
	});
}

export function qcNumbersForCaseIds(caseIds) {
	return ensureQcNumbers({ caseIds });
}

export function qcNumberForCaseId(qcNumbers, caseId) {
	const normalizedCaseId = nonEmptyString(caseId, "caseId");
	const value = qcNumbers?.byCaseId?.get(normalizedCaseId);
	if (!value) fail(`caseId has no QC number: ${normalizedCaseId}`);
	return value;
}
