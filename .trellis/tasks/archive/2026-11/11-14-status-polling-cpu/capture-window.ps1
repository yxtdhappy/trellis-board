param(
  [Parameter(Mandatory = $true)]
  [int]$ProcessId,
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WindowCaptureNative {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int command);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);

    public static IntPtr FindWindowForProcess(int targetProcessId, string title) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hWnd, _) => {
            uint processId;
            GetWindowThreadProcessId(hWnd, out processId);
            if (processId != targetProcessId || !IsWindowVisible(hWnd)) return true;
            var text = new StringBuilder(512);
            GetWindowText(hWnd, text, text.Capacity);
            if (text.ToString() == title) {
                found = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@

$process = Get-Process -Id $ProcessId -ErrorAction Stop
$windowHandle = [WindowCaptureNative]::FindWindowForProcess($ProcessId, 'Trellis Board')
if ($windowHandle -eq [IntPtr]::Zero) {
  throw '未找到 Trellis Board 主窗口'
}
[void][WindowCaptureNative]::ShowWindow($windowHandle, 9)
[void][WindowCaptureNative]::SetForegroundWindow($windowHandle)
Start-Sleep -Milliseconds 500
$rect = New-Object WindowCaptureNative+RECT
if (-not [WindowCaptureNative]::GetWindowRect($windowHandle, [ref]$rect)) {
  throw '读取窗口位置失败'
}

$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $hdc = $graphics.GetHdc()
  try {
    if (-not [WindowCaptureNative]::PrintWindow($windowHandle, $hdc, 2)) {
      throw '捕获窗口内容失败'
    }
  } finally {
    $graphics.ReleaseHdc($hdc)
  }
  $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}

Get-Item -LiteralPath $OutputPath | Select-Object FullName, Length, LastWriteTime
