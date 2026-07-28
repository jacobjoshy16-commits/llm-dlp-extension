<#
.SYNOPSIS
  Force-install County LLM Data Guard and write its policy on Chrome and Edge.

.DESCRIPTION
  Run as SYSTEM via GPO startup script, Intune platform script, or SCCM.

  WHY FORCE-INSTALL IS THE WHOLE POINT
  ------------------------------------
  The README is explicit that the extension only protects against accidental
  disclosure by cooperating employees, and that anyone who disables it defeats
  it. ExtensionInstallForcelist is what closes that gap: a force-installed
  extension cannot be disabled or removed from chrome://extensions, and on
  Chrome/Edge it is granted its declared host permissions WITHOUT the user
  being prompted -- which is also the only way the broad-coverage build is
  deployable at all.

  It also means a broken build cannot be turned off by the user. Stage this to
  a pilot OU before the fleet, every time.

.PARAMETER ExtensionId
  The 32-character extension ID. This is derived from the packing key, so pin
  the key (manifest "key" field or a stable .pem) BEFORE writing any policy --
  an unpacked load generates a new ID every time and your policy silently
  applies to nothing.

.PARAMETER UpdateUrl
  Update manifest URL. For a private deployment host update.xml on an internal
  web server; for store distribution use the Chrome/Edge store update URL.

.PARAMETER PolicyJson
  Path to the managed policy JSON (see enterprise/samples/).

.EXAMPLE
  .\deploy-chrome-edge.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop `
      -UpdateUrl https://dlp.internal.fortbendcountytx.gov/ext/update.xml `
      -PolicyJson .\..\samples\policy-baseline.json
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
  [Parameter(Mandatory)][string]$UpdateUrl,
  [Parameter(Mandatory)][string]$PolicyJson,
  [ValidateSet('Chrome','Edge','Both')][string]$Browser = 'Both',
  [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $PolicyJson)) { throw "policy file not found: $PolicyJson" }
$policy = Get-Content $PolicyJson -Raw | ConvertFrom-Json

$targets = @()
if ($Browser -in 'Chrome','Both') {
  $targets += [pscustomobject]@{ Name='Chrome'; Root='HKLM:\Software\Policies\Google\Chrome' }
}
if ($Browser -in 'Edge','Both') {
  $targets += [pscustomobject]@{ Name='Edge';   Root='HKLM:\Software\Policies\Microsoft\Edge' }
}

function Set-RegValue {
  param($Path, $Name, $Value, $Type = 'String')
  if ($WhatIfOnly) { Write-Host "  would set $Path\$Name = $Value"; return }
  if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
  New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType $Type -Force | Out-Null
}

<#
  Policy values are written as individual registry values under
  ...\3rdparty\extensions\<ID>\policy. Complex types (objects, arrays) go in as
  JSON STRINGS -- that is what chrome.storage.managed expects for anything that
  is not a scalar, and writing them as REG_MULTI_SZ is the classic mistake that
  makes the whole policy blob parse as empty with no error anywhere.
#>
function Write-ManagedPolicy {
  param($PolicyRoot, $Obj)
  foreach ($p in $Obj.PSObject.Properties) {
    if ($p.Name -like '_*') { continue }   # comment keys
    $v = $p.Value
    switch ($true) {
      { $v -is [bool] }   { Set-RegValue $PolicyRoot $p.Name ([int]$v) 'DWord'; break }
      { $v -is [int] -or $v -is [long] -or $v -is [double] } {
        Set-RegValue $PolicyRoot $p.Name ([int]$v) 'DWord'; break
      }
      { $v -is [string] } { Set-RegValue $PolicyRoot $p.Name $v 'String'; break }
      default {
        Set-RegValue $PolicyRoot $p.Name (ConvertTo-Json $v -Depth 12 -Compress) 'String'
      }
    }
  }
}

foreach ($t in $targets) {
  Write-Host "== $($t.Name)"

  # 1. Force-install. Value name is an index; using the ID as the name is a
  #    common error that Chrome ignores silently.
  $forceKey = Join-Path $t.Root 'ExtensionInstallForcelist'
  $existing = @()
  if (Test-Path $forceKey) {
    $existing = (Get-Item $forceKey).Property | ForEach-Object {
      (Get-ItemProperty $forceKey -Name $_).$_
    }
  }
  $entry = "$ExtensionId;$UpdateUrl"
  if ($existing -notcontains $entry) {
    $slot = 1
    while ($existing.Count -ge $slot -and (Test-Path $forceKey) -and
           (Get-Item $forceKey).Property -contains "$slot") { $slot++ }
    Set-RegValue $forceKey "$slot" $entry 'String'
    Write-Host "  force-install slot $slot"
  } else {
    Write-Host "  force-install already present"
  }

  # 2. Prevent the user from removing it via a blanket allowlist elsewhere.
  #    Belt and braces: forcelist alone already pins it, but an explicit
  #    ExtensionSettings entry survives an admin later adding a restrictive
  #    allowlist that would otherwise evict it.
  $settingsPath = Join-Path $t.Root 'ExtensionSettings'
  $settings = @{
    $ExtensionId = @{
      installation_mode = 'force_installed'
      update_url        = $UpdateUrl
      # Explicitly grant the runtime hosts so a broad build does not sit in a
      # "needs permission" state on managed machines.
      toolbar_pin       = 'force_pinned'
    }
  }
  Set-RegValue $settingsPath $ExtensionId (ConvertTo-Json $settings.$ExtensionId -Depth 6 -Compress) 'String'

  # 3. Managed policy for the extension itself.
  $policyRoot = Join-Path $t.Root "3rdparty\extensions\$ExtensionId\policy"
  Write-ManagedPolicy -PolicyRoot $policyRoot -Obj $policy
  Write-Host "  managed policy written"

  # 4. Per-machine attribution. workstationTag is the ONLY attribution source
  #    that works identically on Chrome, Edge, and Firefox, so set it here even
  #    though the policy file may also carry one.
  Set-RegValue $policyRoot 'workstationTag' $env:COMPUTERNAME 'String'
}

Write-Host ""
Write-Host "Done. Verify on the endpoint with:"
Write-Host "  chrome://policy   (Reload policies, then look for the extension section)"
Write-Host "  edge://policy"
Write-Host ""
Write-Host "If the extension section is empty, the ID in the registry path does not"
Write-Host "match the installed extension. That mismatch produces NO error message --"
Write-Host "the extension simply reads an empty managed store and falls back to"
Write-Host "compiled-in defaults, which looks exactly like the policy 'not applying'."
