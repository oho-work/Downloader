param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\dist')
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outputPath = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($outputPath) | Out-Null
$manifest = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'manifest.json') | ConvertFrom-Json
if ($manifest.manifest_version -ne 3 -or $manifest.version -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') {
  throw 'Expected a Manifest V3 extension with a numeric version.'
}
if (@($manifest.permissions) -contains 'proxy') { throw 'The extension must not request browser-wide proxy permission.' }

function Get-ProjectFile([string]$relative) {
  $absolute = [IO.Path]::GetFullPath((Join-Path $projectRoot $relative))
  if (-not $absolute.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Reference escapes the project: $relative"
  }
  if (-not [IO.File]::Exists($absolute)) { throw "Missing packaged dependency: $relative" }
  return $absolute
}

$files = [Collections.Generic.SortedDictionary[string,string]]::new([StringComparer]::Ordinal)
foreach ($directory in @('assets', 'background', 'content', 'lib', 'player', 'popup', 'utils', 'third-party-licenses')) {
  $directoryPath = Join-Path $projectRoot $directory
  if (-not (Test-Path -LiteralPath $directoryPath -PathType Container)) { throw "Missing required runtime/license directory: $directory" }
  foreach ($file in Get-ChildItem -LiteralPath $directoryPath -File -Recurse) {
    $relative = $file.FullName.Substring($projectRoot.Length + 1).Replace('\', '/')
    if ($directory -eq 'lib' -and $file.Extension -notin @('.js', '.mjs', '.wasm')) { continue }
    if ($directory -ne 'third-party-licenses' -and $file.Extension -notin @('.js', '.mjs', '.wasm', '.html', '.css', '.png', '.svg')) {
      throw "Unexpected file in runtime allowlist: $relative"
    }
    $files.Add($relative, $file.FullName)
  }
}
foreach ($relative in @('manifest.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/third-party-sources.md', 'docs/release-checklist.md')) {
  $files.Add($relative, (Get-ProjectFile $relative))
}
$files.Add('README.md', (Get-ProjectFile 'docs/edge-package-readme.md'))
foreach ($relative in @('docs/privacy-policy.md')) {
  if ([IO.File]::Exists((Join-Path $projectRoot $relative))) { $files.Add($relative, (Get-ProjectFile $relative)) }
}

$manifestReferences = @($manifest.background.service_worker, $manifest.action.default_popup)
$manifestReferences += @($manifest.icons.PSObject.Properties | ForEach-Object Value)
if ($manifest.action.default_icon -is [string]) { $manifestReferences += $manifest.action.default_icon }
else { $manifestReferences += @($manifest.action.default_icon.PSObject.Properties | ForEach-Object Value) }
foreach ($script in $manifest.content_scripts) { $manifestReferences += @($script.js); $manifestReferences += @($script.css) }
foreach ($reference in $manifestReferences | Where-Object { $_ }) {
  if (-not $files.ContainsKey($reference)) { throw "Manifest reference absent from archive: $reference" }
}

# Check statically named local JavaScript modules, workers, stylesheets and scripts.
foreach ($entry in @($files.GetEnumerator())) {
  if ($entry.Key -notmatch '\.(?:js|mjs|html)$' -or $entry.Key.StartsWith('lib/hls.')) { continue }
  $source = [IO.File]::ReadAllText($entry.Value)
  $patterns = if ($entry.Key.EndsWith('.html')) {
    @('(?:src|href)\s*=\s*["'']([^"''?#]+)["'']')
  } else {
    @('(?:from\s*|import\s*\(|new\s+URL\s*\()\s*["''](\.{1,2}/[^"'']+)["'']', 'import\s*["''](\.{1,2}/[^"'']+)["'']')
  }
  foreach ($pattern in $patterns) {
    foreach ($match in [regex]::Matches($source, $pattern)) {
      $reference = $match.Groups[1].Value
      if ($reference -match '^(?:https?:|data:|#)') { continue }
      $absolute = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetDirectoryName($entry.Value)) $reference))
      $relative = $absolute.Substring($projectRoot.Length + 1).Replace('\', '/')
      if (-not $files.ContainsKey($relative)) { throw "Local dependency absent from archive: $($entry.Key) -> $reference" }
    }
  }
}

Add-Type -AssemblyName System.IO.Compression
function Write-DeterministicZip([string]$archivePath, [Collections.Generic.SortedDictionary[string,string]]$entries) {
  $stream = [IO.File]::Open($archivePath, [IO.FileMode]::Create, [IO.FileAccess]::Write)
  try {
    $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
    try {
      foreach ($entry in $entries.GetEnumerator()) {
        $item = $zip.CreateEntry($entry.Key, [IO.Compression.CompressionLevel]::Optimal)
        $item.LastWriteTime = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
        $inputStream = [IO.File]::OpenRead($entry.Value)
        $outputStream = $item.Open()
        try { $inputStream.CopyTo($outputStream) } finally { $inputStream.Dispose(); $outputStream.Dispose() }
      }
    } finally { $zip.Dispose() }
  } finally { $stream.Dispose() }
}

$extensionZip = Join-Path $outputPath "hls-cache-player-edge-$($manifest.version).zip"
Write-DeterministicZip $extensionZip $files

$companion = [Collections.Generic.SortedDictionary[string,string]]::new([StringComparer]::Ordinal)
$companion.Add('tools/download-relay.cjs', (Get-ProjectFile 'tools/download-relay.cjs'))
$companion.Add('LICENSE', (Get-ProjectFile 'LICENSE'))
$companion.Add('README.md', (Get-ProjectFile 'docs/download-relay.md'))
$relayZip = Join-Path $outputPath "hls-cache-player-relay-$($manifest.version).zip"
Write-DeterministicZip $relayZip $companion

$archives = @($extensionZip, $relayZip) | ForEach-Object {
  [ordered]@{ file = [IO.Path]::GetFileName($_); bytes = (Get-Item -LiteralPath $_).Length; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_).Hash.ToLowerInvariant() }
}
$report = [ordered]@{
  version = $manifest.version
  status = 'LOCAL_CANDIDATE_NOT_CLEARED_FOR_PUBLIC_REDISTRIBUTION'
  releaseChecklist = 'docs/release-checklist.md'
  note = 'Packaging verifies archive structure only. Resolve the third-party source/build and release checklist blockers before store upload.'
  archives = $archives
  extensionFileCount = $files.Count
  extensionFiles = @($files.GetEnumerator() | ForEach-Object {
    [ordered]@{ path = $_.Key; bytes = (Get-Item -LiteralPath $_.Value).Length; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.Value).Hash.ToLowerInvariant() }
  })
}
$reportPath = Join-Path $outputPath "package-report-$($manifest.version).json"
[IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 6) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
$archives | ForEach-Object { Write-Output ("{0}  {1} bytes  SHA256 {2}" -f $_.file, $_.bytes, $_.sha256) }
Write-Output "Local candidate only. Package report: $reportPath"
