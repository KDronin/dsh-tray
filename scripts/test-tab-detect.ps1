$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinF2 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
"@
$script:found = @()
$cb = [WinF2+EnumProc]{ param($h, $l)
  $sb = New-Object System.Text.StringBuilder 512
  [void][WinF2]::GetWindowText($h, $sb, 512)
  $t = $sb.ToString()
  if ($t -match 'DeepSeek Harness' -and [WinF2]::IsWindowVisible($h)) { $script:found += $t }
  return $true
}
[void][WinF2]::EnumWindows($cb, [IntPtr]::Zero)
if ($script:found.Count -gt 0) {
  $script:found | ForEach-Object { Write-Output "MATCH: [$_]" }
} else {
  Write-Output 'NOTFOUND'
}
