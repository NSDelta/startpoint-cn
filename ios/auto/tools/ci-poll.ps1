# 轮询 ios-autoclick 的一次 CI 运行到底，打印每一步的结论。
# 用法： & .\ci-poll.ps1 -Sha <40 位 sha>
# 只用 PowerShell 5.1 支持的语法（没有三元运算符）。
param([Parameter(Mandatory=$true)][string]$Sha)

Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class CMHX {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL { public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize;
    public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  public static string Read(string t) { IntPtr p; if (!CredRead(t,1,0,out p)) return null;
    try { CREDENTIAL c=(CREDENTIAL)Marshal.PtrToStructure(p,typeof(CREDENTIAL));
      return Marshal.PtrToStringUni(c.CredentialBlob,(int)(c.CredentialBlobSize/2)); } finally { CredFree(p); } } }
'@
$h = @{ Authorization = "Bearer $([CMHX]::Read('git:https://github.com'))"
        Accept = 'application/vnd.github+json'; 'User-Agent' = 'dsh' }

$id = $null
for ($i = 1; $i -le 20; $i++) {
    $r = Invoke-RestMethod -Uri "https://api.github.com/repos/NSDelta/startpoint-cn/actions/runs?branch=ci-ios-autoclick&per_page=10" -Headers $h -TimeoutSec 25
    $w = $r.workflow_runs | Where-Object { $_.head_sha -eq $Sha -and $_.name -eq 'ios-autoclick' }
    if ($w) { $id = $w.id; break }
    Start-Sleep -Seconds 6
}
if (-not $id) { "找不到 sha=$Sha 的运行"; exit 1 }
"run id = $id  https://github.com/NSDelta/startpoint-cn/actions/runs/$id"

for ($i = 1; $i -le 100; $i++) {
    Start-Sleep -Seconds 20
    $j = Invoke-RestMethod -Uri "https://api.github.com/repos/NSDelta/startpoint-cn/actions/runs/$id/jobs" -Headers $h -TimeoutSec 25
    $parts = $j.jobs | ForEach-Object {
        $mark = ''
        if ($_.status -ne 'completed') { $mark = '*' }
        "$($_.name)=$($_.conclusion)$mark"
    }
    "[$i] " + ($parts -join '  ')
    if (($j.jobs | Where-Object { $_.status -ne 'completed' }).Count -eq 0) {
        "ALL_DONE run=$id"
        foreach ($job in $j.jobs) {
            $bad = $job.steps | Where-Object { $_.conclusion -ne 'success' -and $_.conclusion -ne 'skipped' }
            if ($bad) {
                $s = ($bad | ForEach-Object { "$($_.number).$($_.name)=$($_.conclusion)" }) -join ', '
                "  失败步骤  $($job.name): $s"
            }
        }
        exit 0
    }
}
"超时未完成（run=$id）"
