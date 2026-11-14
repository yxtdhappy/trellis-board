param(
  [Parameter(Mandatory = $true)]
  [int]$ProcessId,
  [string]$Pattern = ''
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class TrellisUiWindowFinder {
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

$windowHandle = [TrellisUiWindowFinder]::Find($ProcessId, 'Trellis Board')
if ($windowHandle -eq [IntPtr]::Zero) {
  throw '未找到 Trellis Board 主窗口'
}

$root = [System.Windows.Automation.AutomationElement]::FromHandle($windowHandle)
$elements = $root.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.Condition]::TrueCondition
)
$seen = [System.Collections.Generic.HashSet[string]]::new()
$matches = foreach ($element in $elements) {
  $name = $element.Current.Name
  if (-not $name -or -not $seen.Add($name)) {
    continue
  }
  if (-not $Pattern -or $name -match $Pattern) {
    [pscustomobject]@{
      name = $name
      controlType = $element.Current.ControlType.ProgrammaticName
      enabled = $element.Current.IsEnabled
      offscreen = $element.Current.IsOffscreen
    }
  }
}
@($matches) | ConvertTo-Json -Depth 3
