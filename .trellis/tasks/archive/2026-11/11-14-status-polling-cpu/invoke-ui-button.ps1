param(
  [Parameter(Mandatory = $true)]
  [int]$ProcessId,
  [Parameter(Mandatory = $true)]
  [string]$Name,
  [int]$WaitMilliseconds = 3000
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class TrellisWindowFinder {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

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

$windowHandle = [TrellisWindowFinder]::Find($ProcessId, 'Trellis Board')
if ($windowHandle -eq [IntPtr]::Zero) {
  throw '未找到 Trellis Board 主窗口'
}

$root = [System.Windows.Automation.AutomationElement]::FromHandle($windowHandle)
$condition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty,
  $Name
)
$element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
if (-not $element) {
  throw "未找到 UI 元素: $Name"
}

$pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
$pattern.Invoke()
Start-Sleep -Milliseconds $WaitMilliseconds

[pscustomobject]@{
  name = $Name
  automationId = $element.Current.AutomationId
  enabled = $element.Current.IsEnabled
  offscreen = $element.Current.IsOffscreen
} | ConvertTo-Json
