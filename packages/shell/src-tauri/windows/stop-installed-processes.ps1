# The installer supplies this through its environment, not through script text.
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($env:NAIA_INSTALL_ROOT).TrimEnd('\') + '\'
if ($root.Length -le 3 -or -not [IO.Path]::IsPathRooted($root)) {
    throw 'Invalid installation directory'
}
# This script is a child of NSIS. Never terminate the installer or uninstaller.
$self = Get-CimInstance Win32_Process -Filter "ProcessId = $PID"
$installerPid = [uint32]$self.ParentProcessId
$processes = @(Get-CimInstance Win32_Process)
foreach ($process in $processes) {
    if ($process.ProcessId -eq $PID -or $process.ProcessId -eq $installerPid) { continue }
    $path = $process.ExecutablePath
    if (-not $path) { continue }
    $path = [IO.Path]::GetFullPath($path)
    if ($path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        try {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
            Wait-Process -Id $process.ProcessId -Timeout 15 -ErrorAction Stop
        } catch {
            if (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue) { throw }
        }
    }
}
