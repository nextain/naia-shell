// 웹 모드 전용 영어 문구.
// 데스크톱 운영 빌드에는 싣지 않는다.
export default {
	"webModel.checking": "Checking local model…",
	"webModel.loading": "Downloading {model} ({percent}%). Sending blocked until ready.",
	"webModel.ready": "Local model ready: {model}",
	"webModel.fallbackActive": "Fallback model active.",
	"webModel.adapter": "GPU: {adapter} · shader-f16 {f16}",
	"webModel.f16Yes": "yes",
	"webModel.f16No": "no",
	"webModel.adapterUnknown": "Unknown adapter",
	"webModel.errorNoWebgpu": "WebGPU is unavailable in this browser. Open in latest Chrome.",
	"webModel.errorNoShaderF16": "GPU lacks shader-f16 to run {model}.",
	"webModel.errorDeviceLost": "Insufficient GPU memory for {model}.",
	"webModel.errorLoadFailed": "Failed to load {model}.",
	"webModel.useFallback": "Use {model}",
	"webModel.backToDefault": "Back to default model {model}",
	"webModel.retry": "Retry",
	"webModel.details": "Details",
	"webWorkspace.description": "Workspaces are stored only inside this browser.",
	"webWorkspace.startDefault": "Start with default workspace",
	"webWorkspace.installing": "Preparing workspace {done}/{total}",
	"webWorkspace.retry": "Retry",
} as const;
