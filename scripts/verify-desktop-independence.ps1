param([switch]$Launcher,[string]$Executable=(Join-Path (Split-Path -Parent $PSScriptRoot) 'src-tauri\target\release\stashdock.exe'))
$projectRoot=Split-Path -Parent $PSScriptRoot
$ErrorActionPreference='Stop'
$resolved=(Resolve-Path -LiteralPath $Executable).Path
if($resolved -ne (Join-Path $projectRoot 'src-tauri\target\release\stashdock.exe')){throw 'Only the project-built desktop is in scope.'}
if($Launcher){
  Start-Process -FilePath $resolved -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 45
  exit
}
if(Get-Process stashdock -ErrorAction SilentlyContinue){throw 'Close StashDock before this isolated launcher test; never terminate a user instance.'}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class OwnedDesktopLauncher {
 [StructLayout(LayoutKind.Sequential)] public struct SI {public int cb; public IntPtr reserved,desktop,title; public int x,y,w,h,xc,yc,fill,flags; public short show,reserved2; public IntPtr r2,input,output,error;}
 [StructLayout(LayoutKind.Sequential)] public struct PI {public IntPtr process,thread;public int pid,tid;}
 [StructLayout(LayoutKind.Sequential)] public struct Basic {public long processTime,jobTime;public uint flags;public UIntPtr min,max;public uint active;public UIntPtr affinity;public uint priority,scheduling;}
 [StructLayout(LayoutKind.Sequential)] public struct Io {public ulong a,b,c,d,e,f;}
 [StructLayout(LayoutKind.Sequential)] public struct Limits {public Basic basic;public Io io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool CreateProcessW(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SI start,out PI info);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr CreateJobObjectW(IntPtr attributes,IntPtr name);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job,int type,ref Limits info,int length);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
 [DllImport("kernel32.dll")] public static extern bool TerminateProcess(IntPtr process,uint code);
 public static void Check(bool result){if(!result)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
}
'@
$job=[OwnedDesktopLauncher]::CreateJobObjectW([IntPtr]::Zero,[IntPtr]::Zero)
if($job -eq [IntPtr]::Zero){throw 'Could not create owned test Job Object.'}
$info=New-Object OwnedDesktopLauncher+PI
$ownedApp=$null
$previousData=$env:STASHDOCK_DATA_DIR
try {
  $fixture=Join-Path (Join-Path $projectRoot 'output') ('desktop-independent-'+[Guid]::NewGuid().ToString('N'))
  [void](New-Item -ItemType Directory -Path $fixture)
  $env:STASHDOCK_DATA_DIR=$fixture
  $limits=New-Object OwnedDesktopLauncher+Limits
  # Nested structs are value types. Assign the initialized value back instead
  # of mutating PowerShell's boxed copy of limits.basic.
  $basic=New-Object OwnedDesktopLauncher+Basic
  $basic.flags=0x2000 # KILL_ON_JOB_CLOSE, not breakaway-enabled.
  $limits.basic=$basic
  [OwnedDesktopLauncher]::Check([OwnedDesktopLauncher]::SetInformationJobObject($job,9,[ref]$limits,[Runtime.InteropServices.Marshal]::SizeOf($limits)))
  $start=New-Object OwnedDesktopLauncher+SI
  $start.cb=[Runtime.InteropServices.Marshal]::SizeOf($start)
  $shell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $command=New-Object Text.StringBuilder
  [void]$command.Append(('"{0}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{1}" -Launcher -Executable "{2}"' -f $shell,$PSCommandPath,$resolved))
  [OwnedDesktopLauncher]::Check([OwnedDesktopLauncher]::CreateProcessW($shell,$command,[IntPtr]::Zero,[IntPtr]::Zero,$false,0x08000004,[IntPtr]::Zero,$projectRoot,[ref]$start,[ref]$info))
  [OwnedDesktopLauncher]::Check([OwnedDesktopLauncher]::AssignProcessToJobObject($job,$info.process))
  if([OwnedDesktopLauncher]::ResumeThread($info.thread) -eq [uint32]::MaxValue){throw 'Owned launcher could not resume.'}
  for($i=0;$i -lt 100;$i++){
    $candidate=Get-CimInstance Win32_Process -Filter "name='stashdock.exe'" | Where-Object {$_.ExecutablePath -eq $resolved -and $_.CommandLine -match '--stashdock-independent'} | Select-Object -First 1
    if($candidate){$ownedApp=Get-Process -Id $candidate.ProcessId;break}
    Start-Sleep -Milliseconds 100
  }
  if(-not $ownedApp){throw 'Independent desktop did not start.'}
  $owner=Get-CimInstance Win32_Process -Filter ('ProcessId='+$candidate.ParentProcessId)
  if($owner.Name -ne 'explorer.exe'){throw 'The desktop was not handed to the interactive Windows shell.'}
  [bool]$inJob=$false
  [OwnedDesktopLauncher]::Check([OwnedDesktopLauncher]::IsProcessInJob($ownedApp.Handle,[IntPtr]::Zero,[ref]$inJob))
  [void][OwnedDesktopLauncher]::CloseHandle($job);$job=[IntPtr]::Zero
  Start-Sleep -Seconds 2
  $ownedApp.Refresh()
  if($ownedApp.HasExited){throw 'Desktop exited together with the owned launcher.'}
  if(Get-Process -Id $info.pid -ErrorAction SilentlyContinue){throw 'Owned launcher did not exit when its job closed.'}
  & (Join-Path $PSScriptRoot 'verify-desktop-windows.ps1') -AppProcessId $ownedApp.Id -Surface panel
  @{independent=$true;launcherKilled=$true;desktopSurvived=$true;outsideJob=(-not $inJob);creationParent=$owner.Name;isolatedLibrary=$fixture} | ConvertTo-Json -Compress
} finally {
  $env:STASHDOCK_DATA_DIR=$previousData
  if($job -ne [IntPtr]::Zero){[void][OwnedDesktopLauncher]::CloseHandle($job)}
  if($info.process -ne [IntPtr]::Zero){[void][OwnedDesktopLauncher]::TerminateProcess($info.process,1);[void][OwnedDesktopLauncher]::CloseHandle($info.process)}
  if($info.thread -ne [IntPtr]::Zero){[void][OwnedDesktopLauncher]::CloseHandle($info.thread)}
  if($ownedApp -and -not $ownedApp.HasExited -and $ownedApp.Path -eq $resolved){Stop-Process -Id $ownedApp.Id}
}
