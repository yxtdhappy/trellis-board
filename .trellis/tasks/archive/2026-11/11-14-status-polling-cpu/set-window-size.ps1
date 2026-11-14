param(
  [Parameter(Mandatory = $true)]
  [int]$ProcessId,
  [int]$Width = 1920,
  [int]$Height = 1000
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class TrellisWindowSizer {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

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
    public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int width, int height, bool repaint);

    public static IntPtr Find(int targetProcessId, string title) {
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

$windowHandle = [TrellisWindowSizer]::Find($ProcessId, 'Trellis Board')
if ($windowHandle -eq [IntPtr]::Zero) {
  throw '未找到 Trellis Board 主窗口'
}
[void][TrellisWindowSizer]::ShowWindow($windowHandle, 9)
[void][TrellisWindowSizer]::MoveWindow($windowHandle, 20, 20, $Width, $Height, $true)
