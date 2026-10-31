import path from "node:path";
import ts from "typescript";
import { resolveWebAgentDir } from "./web-agent-dir.mjs";

let agentDir;
try {
	agentDir = resolveWebAgentDir(process.env);
} catch (err) {
	process.stderr.write(
		`${err instanceof Error ? err.message : String(err)}\n`,
	);
	process.exit(2);
}

const configPath = path.resolve("tsconfig.web-worker.json");
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
	const host = {
		getCanonicalFileName: (f) => f,
		getCurrentDirectory: () => process.cwd(),
		getNewLine: () => "\n",
	};
	process.stderr.write(
		`${ts.formatDiagnosticsWithColorAndContext([configFile.error], host)}\n`,
	);
	process.exit(1);
}

const basePath = path.dirname(configPath);
const parsedConfig = ts.parseJsonConfigFileContent(
	configFile.config,
	ts.sys,
	basePath,
);

parsedConfig.options.baseUrl = basePath;
parsedConfig.options.paths = {
	...(parsedConfig.options.paths || {}),
	"@naia-agent/*": [path.join(agentDir, "src/main/*")],
};

const program = ts.createProgram({
	rootNames: parsedConfig.fileNames,
	options: parsedConfig.options,
});

const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length > 0) {
	const host = {
		getCanonicalFileName: (f) => f,
		getCurrentDirectory: () => process.cwd(),
		getNewLine: () => "\n",
	};
	process.stderr.write(
		ts.formatDiagnosticsWithColorAndContext(diagnostics, host),
	);
	process.exit(1);
}

const sourceFileNames = program
	.getSourceFiles()
	.map((sf) => path.resolve(sf.fileName));
const requiredFile1 = path.resolve(
	path.join(agentDir, "src/main/adapters/webllm-provider.ts"),
);
const requiredFile2 = path.resolve(
	path.join(agentDir, "src/main/composition/browser-agent.ts"),
);

if (
	!sourceFileNames.includes(requiredFile1) ||
	!sourceFileNames.includes(requiredFile2)
) {
	process.stderr.write(
		"필수 에이전트 소스 파일이 프로그램 소스 파일에 포함되지 않았습니다.\n",
	);
	process.exit(1);
}

process.stdout.write("Web worker type check passed.\n");
process.exit(0);
