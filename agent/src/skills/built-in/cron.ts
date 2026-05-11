import type { CronStore } from "../../cron/store.js";
import type { CronSchedule } from "../../cron/types.js";
import {
	addCronJob,
	getCronRuns,
	getCronStatus,
	listCronJobs,
	removeCronJob,
	runCronJob,
} from "../../gateway/cron-proxy.js";
import { cronDescriptor } from "@naia-adk/skills-builtin";
import type { SkillDefinition, SkillResult } from "../types.js";

function parseSchedule(
	scheduleType: string,
	scheduleValue: string,
): CronSchedule {
	switch (scheduleType) {
		case "at":
			return { type: "at", date: scheduleValue };
		case "every":
			return { type: "every", intervalMs: Number.parseInt(scheduleValue, 10) };
		case "cron":
			return { type: "cron", expression: scheduleValue };
		default:
			throw new Error(`Unknown schedule type: ${scheduleType}`);
	}
}

export function createCronSkill(store: CronStore): SkillDefinition {
	return {
		name: `skill_${cronDescriptor.name}`,
		description: cronDescriptor.description,
		parameters: cronDescriptor.inputSchema,
		tier: 1,
		requiresGateway: false,
		source: "built-in",
		execute: async (
			args: Record<string, unknown>,
			ctx,
		): Promise<SkillResult> => {
			const action = args.action as string;

			switch (action) {
				// --- Local actions ---
				case "add": {
					const label = (args.label as string) || "Unnamed job";
					const task = (args.task as string) || "";
					const scheduleType = (args.schedule_type as string) || "at";
					const scheduleValue = (args.schedule_value as string) || "";

					if (!scheduleValue) {
						return {
							success: false,
							output: "",
							error: "schedule_value is required",
						};
					}

					try {
						const schedule = parseSchedule(scheduleType, scheduleValue);
						const job = store.add({ label, task, schedule });
						return {
							success: true,
							output: JSON.stringify({
								message: `Job created: ${job.label}`,
								job,
							}),
						};
					} catch (err) {
						return {
							success: false,
							output: "",
							error: err instanceof Error ? err.message : String(err),
						};
					}
				}

				case "list": {
					const jobs = store.list();
					return {
						success: true,
						output: JSON.stringify(jobs),
					};
				}

				case "remove": {
					const jobId = args.job_id as string;
					if (!jobId) {
						return {
							success: false,
							output: "",
							error: "job_id is required for remove",
						};
					}
					const removed = store.remove(jobId);
					return {
						success: removed,
						output: removed ? `Job ${jobId} removed` : `Job ${jobId} not found`,
						error: removed ? undefined : "Job not found",
					};
				}

				case "update": {
					const jobId = args.job_id as string;
					if (!jobId) {
						return {
							success: false,
							output: "",
							error: "job_id is required for update",
						};
					}
					const patch: Record<string, unknown> = {};
					if (args.enabled !== undefined) patch.enabled = args.enabled;
					if (args.label !== undefined) patch.label = args.label;
					if (args.task !== undefined) patch.task = args.task;

					const updated = store.update(jobId, patch);
					if (!updated) {
						return {
							success: false,
							output: "",
							error: `Job ${jobId} not found`,
						};
					}
					return {
						success: true,
						output: JSON.stringify({
							message: `Job ${jobId} updated`,
							job: updated,
						}),
					};
				}

				// --- Gateway actions ---
				case "gateway_list": {
					const gateway = ctx.gateway;
					if (!gateway?.isConnected()) {
						return {
							success: false,
							output: "",
							error:
								"Gateway not connected. gateway_list requires a running Gateway.",
						};
					}
					const result = await listCronJobs(gateway);
					return { success: true, output: JSON.stringify(result) };
				}

				case "gateway_status": {
					const gateway = ctx.gateway;
					if (!gateway?.isConnected()) {
						return {
							success: false,
							output: "",
							error:
								"Gateway not connected. gateway_status requires a running Gateway.",
						};
					}
					const result = await getCronStatus(gateway);
					return { success: true, output: JSON.stringify(result) };
				}

				case "gateway_add": {
					const gateway = ctx.gateway;
					if (!gateway?.isConnected()) {
						return {
							success: false,
							output: "",
							error:
								"Gateway not connected. gateway_add requires a running Gateway.",
						};
					}
					const name = (args.label as string) || "Unnamed job";
					const scheduleType = (args.schedule_type as string) || "cron";
					const scheduleValue = (args.schedule_value as string) || "";
					if (!scheduleValue) {
						return {
							success: false,
							output: "",
							error: "schedule_value is required",
						};
					}
					const schedule: Record<string, unknown> = { type: scheduleType };
					if (scheduleType === "cron") schedule.expression = scheduleValue;
					else if (scheduleType === "every")
						schedule.intervalMs = Number.parseInt(scheduleValue, 10);
					else if (scheduleType === "at") schedule.date = scheduleValue;

					const result = await addCronJob(gateway, {
						name,
						schedule: schedule as {
							type: string;
							expression?: string;
							intervalMs?: number;
							date?: string;
						},
					});
					return { success: true, output: JSON.stringify(result) };
				}

				case "gateway_run": {
					const gateway = ctx.gateway;
					if (!gateway?.isConnected()) {
						return {
							success: false,
							output: "",
							error:
								"Gateway not connected. gateway_run requires a running Gateway.",
						};
					}
					const jobId = args.job_id as string;
					if (!jobId) {
						return {
							success: false,
							output: "",
							error: "job_id is required for gateway_run",
						};
					}
					const result = await runCronJob(gateway, jobId);
					return { success: true, output: JSON.stringify(result) };
				}

				case "gateway_runs": {
					const gateway = ctx.gateway;
					if (!gateway?.isConnected()) {
						return {
							success: false,
							output: "",
							error:
								"Gateway not connected. gateway_runs requires a running Gateway.",
						};
					}
					const jobId = args.job_id as string;
					if (!jobId) {
						return {
							success: false,
							output: "",
							error: "job_id is required for gateway_runs",
						};
					}
					const result = await getCronRuns(gateway, jobId);
					return { success: true, output: JSON.stringify(result) };
				}

				case "gateway_remove": {
					const gateway = ctx.gateway;
					if (!gateway?.isConnected()) {
						return {
							success: false,
							output: "",
							error:
								"Gateway not connected. gateway_remove requires a running Gateway.",
						};
					}
					const jobId = args.job_id as string;
					if (!jobId) {
						return {
							success: false,
							output: "",
							error: "job_id is required for gateway_remove",
						};
					}
					const result = await removeCronJob(gateway, jobId);
					return { success: true, output: JSON.stringify(result) };
				}

				default:
					return {
						success: false,
						output: "",
						error: `Unknown action: ${action}`,
					};
			}
		},
	};
}
