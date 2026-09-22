#!/usr/bin/env node
// Prepares the paired naia-agent checkout and its naia-memory sibling exactly
// as `tauri:dev` / `tauri:prod` do, so strict resolvers (stage-runtime,
// build-e2e-tauri, wdio) can name one command when no checkout exists (#685).
import { ensurePairedAgentCheckout } from "./agent-pairing.mjs";

const { pairedAgent, agentScript, agentProtoDir } = ensurePairedAgentCheckout();
process.stdout.write(`[prepare-paired-agent] agent=${pairedAgent}\n  NAIA_AGENT_SCRIPT=${agentScript}\n  NAIA_AGENT_PROTO_DIR=${agentProtoDir}\n`);
