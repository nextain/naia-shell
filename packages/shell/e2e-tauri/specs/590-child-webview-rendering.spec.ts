import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const ARTIFACTS = resolve(
	process.env.NAIA_E2E_ARTIFACTS_DIR ?? resolve(process.env.LOCALAPPDATA ?? process.cwd(), "naia-590"),
);
mkdirSync(ARTIFACTS, { recursive: true });

/** Capture the foreground native window, including the child WebView. */
function captureDesktopWindow(path: string): void {
	if (process.platform !== "win32") {
		throw new Error("590 child-WebView evidence requires the Windows desktop capture path");
	}
	const escaped = path.replace(/'/g, "''");
	const script = `
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies 'System.Drawing' @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public static class WindowCapture {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static void Save(string path) {
    var h = GetForegroundWindow();
    RECT r; if (h == IntPtr.Zero || !GetWindowRect(h, out r)) throw new Exception("foreground window unavailable");
    var bitmap = new Bitmap(r.Right - r.Left, r.Bottom - r.Top);
    var graphics = Graphics.FromImage(bitmap);
    try { graphics.CopyFromScreen(r.Left, r.Top, 0, 0, bitmap.Size); bitmap.Save(path); }
    finally { graphics.Dispose(); bitmap.Dispose(); }
  }
}
'@
[WindowCapture]::Save('${escaped}')
`;
	execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
		stdio: "pipe",
	});
}

async function activateBrowser(): Promise<void> {
	await (await $('.app-bar-tab[data-app-id="browser"]')).waitForExist({ timeout: 30_000 });
	await browser.execute(() => {
		(document.querySelector('.app-bar-tab[data-app-id="browser"]') as HTMLButtonElement).click();
	});
	await browser.waitUntil(
		async () => browser.execute(() => Boolean(
			document.querySelector('.content-app__slot--active .browser-app'),
		)),
		{ timeout: 15_000, timeoutMsg: "browser app did not become active" },
	);
	await (await $("input.browser-app__url-input")).waitForDisplayed({ timeout: 15_000 });
}

async function submitAddressBar(url: string): Promise<void> {
	const addressBar = await $("input.browser-app__url-input");
	await addressBar.click();
	await addressBar.setValue(url);
	try {
		await browser.keys("Enter");
	} catch {
		// Creating the real child invalidates the main WebDriver session. The
		// submit event has already reached React before that expected teardown.
	}
}

function submitSecondUrlWithDesktopInput(url: string): void {
	const escaped = url.replace(/'/g, "''");
	const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class Mouse { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e); public struct RECT { public int Left; public int Top; public int Right; public int Bottom; } }
'@
$r = New-Object Mouse+RECT; [Mouse]::GetWindowRect([Mouse]::GetForegroundWindow(), [ref]$r) | Out-Null
[Mouse]::SetCursorPos($r.Left + (($r.Right - $r.Left) / 2), $r.Top + 95) | Out-Null
[Mouse]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [Mouse]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
[System.Windows.Forms.SendKeys]::SendWait('^a'); [System.Windows.Forms.SendKeys]::SendWait('${escaped}'); [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
`;
	execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "pipe" });
}

describe("#590 item 8 — native child WebView rendering", () => {
	it("renders both pages in the real child WebView", async () => {
		await activateBrowser();
		await submitAddressBar("https://example.com");
		await new Promise((resolve) => setTimeout(resolve, 5_000));
		captureDesktopWindow(resolve(ARTIFACTS, "example-com.png"));
		console.log(`[590] example.com desktop screenshot: ${resolve(ARTIFACTS, "example-com.png")}`);
		submitSecondUrlWithDesktopInput("https://www.wikipedia.org");
		await new Promise((resolve) => setTimeout(resolve, 7_000));
		captureDesktopWindow(resolve(ARTIFACTS, "wikipedia-org.png"));
		console.log(`[590] wikipedia.org desktop screenshot: ${resolve(ARTIFACTS, "wikipedia-org.png")}`);
	});
});
