param([string]$Destination = '')
$ErrorActionPreference = 'Stop'
function Get-ReleaseHash([string]$Path) {
  $taskStream = [IO.File]::OpenRead($Path)
  $taskHash = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($taskHash.ComputeHash($taskStream)).Replace('-','').ToLowerInvariant() }
  finally { $taskStream.Dispose(); $taskHash.Dispose() }
}
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskPlugin = Join-Path $taskRoot 'plugins\stashdock'
$taskMetadata = Get-Content -Raw -LiteralPath (Join-Path $taskPlugin '.codex-plugin\plugin.json') | ConvertFrom-Json
$taskLock = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'node-runtime-lock.json') | ConvertFrom-Json
if (-not $Destination) { $Destination = Join-Path $taskRoot ("output\releases\stashdock-plugin-" + $taskMetadata.version + '-win32-x64') }
$taskStage = [IO.Path]::GetFullPath($Destination)
if ((Test-Path -LiteralPath $taskStage) -or (Test-Path -LiteralPath ($taskStage + '.zip'))) { throw 'Release already exists. Use a new destination.' }
if ((Get-ReleaseHash (Join-Path $taskPlugin 'bin\win32-x64\node.exe')) -ne $taskLock.sha256) { throw 'Bundled Node checksum mismatch. Run npm run plugin:build.' }
$taskTarget = Join-Path $taskStage 'plugins\stashdock'
[void][IO.Directory]::CreateDirectory($taskTarget)
# Explicit runtime allowlist, not a copy of the developer working directory.
foreach ($taskFolder in @('.codex-plugin','assets','dist','notices','scripts','skills','web')) {
  Copy-Item -LiteralPath (Join-Path $taskPlugin $taskFolder) -Destination (Join-Path $taskTarget $taskFolder) -Recurse
}
[void][IO.Directory]::CreateDirectory((Join-Path $taskTarget 'bin\win32-x64'))
foreach ($taskBinary in @('node.exe','stashdock-preview.exe','stashdock-storage.exe','stashdock-browser.exe')) {
  Copy-Item -LiteralPath (Join-Path $taskPlugin ('bin\win32-x64\'+$taskBinary)) -Destination (Join-Path $taskTarget ('bin\win32-x64\'+$taskBinary))
}
Copy-Item -LiteralPath (Join-Path $taskPlugin '.mcp.json') -Destination (Join-Path $taskTarget '.mcp.json')
[void][IO.Directory]::CreateDirectory((Join-Path $taskTarget 'server'))
foreach ($taskSql in @('schema.sql','search-index.sql','preview-version.sql')) {
  Copy-Item -LiteralPath (Join-Path $taskPlugin ('server\'+$taskSql)) -Destination (Join-Path $taskTarget ('server\'+$taskSql))
}
[void][IO.Directory]::CreateDirectory((Join-Path $taskStage '.agents\plugins'))
Copy-Item -LiteralPath (Join-Path $taskRoot '.agents\plugins\marketplace.json') -Destination (Join-Path $taskStage '.agents\plugins\marketplace.json')
foreach ($taskLicense in @('LICENSE','LICENSING.md','THIRD_PARTY_NOTICES.md')) {
  Copy-Item -LiteralPath (Join-Path $taskRoot $taskLicense) -Destination (Join-Path $taskStage $taskLicense)
  Copy-Item -LiteralPath (Join-Path $taskRoot $taskLicense) -Destination (Join-Path $taskTarget $taskLicense)
}
[void][IO.Directory]::CreateDirectory((Join-Path $taskTarget 'licenses'))
Copy-Item -LiteralPath (Join-Path $taskRoot 'licenses/StashDock-legacy-MIT.txt') -Destination (Join-Path $taskTarget 'licenses/StashDock-legacy-MIT.txt')
Copy-Item -LiteralPath (Join-Path $taskRoot 'docs\windows-plugin-install.md') -Destination (Join-Path $taskStage 'README.md')
$taskRecords = @(Get-ChildItem -LiteralPath $taskStage -File -Recurse -Force | ForEach-Object {
  if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Release must not contain symlinks.' }
  if ($_.Extension -in @('.pdb','.map','.sqlite3','.db') -or $_.FullName.Contains('preview-runtime')) { throw 'Unexpected development/runtime artifact in release.' }
  [pscustomobject]@{path=$_.FullName.Substring($taskStage.Length+1).Replace('\','/');bytes=$_.Length;sha256=(Get-ReleaseHash $_.FullName)}
})
$taskManifest = [ordered]@{formatVersion=1;platform='win32-x64';version=$taskMetadata.version;renderer='System Evergreen WebView2';node=$taskLock.version;files=$taskRecords}
[IO.File]::WriteAllText((Join-Path $taskStage 'RELEASE_MANIFEST.json'),($taskManifest | ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($taskStage,($taskStage+'.zip'),[IO.Compression.CompressionLevel]::Optimal,$false)
$taskBytes = ($taskRecords | Measure-Object -Property bytes -Sum).Sum + (Get-Item -LiteralPath (Join-Path $taskStage 'RELEASE_MANIFEST.json')).Length
[pscustomobject]@{folder=$taskStage;zip=($taskStage+'.zip');unpackedBytes=$taskBytes;zipBytes=(Get-Item -LiteralPath ($taskStage+'.zip')).Length;sha256=(Get-ReleaseHash ($taskStage+'.zip'))} | ConvertTo-Json
