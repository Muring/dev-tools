<#
.SYNOPSIS
  새 Windows PC 에 WSL2 + Ubuntu 를 올리고 리눅스 쪽 setup.sh 까지 실행한다.
.NOTES
  관리자 권한이 필요하다(wsl --install). WSL 기능이 처음 켜지는 PC 는 재부팅이 한 번 낀다.
#>
[CmdletBinding()]
param(
  [string]$User   = $env:USERNAME.ToLower(),
  [string]$Distro = 'Ubuntu',
  [string]$Repo   = 'https://github.com/Muring/dev-tools.git',
  [ValidatePattern('^[A-Za-z]:?$')][string]$InstallDrive,
  [string]$InstallLocation,
  [string]$ConfigFile
)

$ErrorActionPreference = 'Stop'
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    !   $m" -ForegroundColor Yellow }

# Keep these functions in this file: the initial bootstrap is downloaded standalone.
# 이 스크립트는 단독 다운로드로 실행되므로 app-host.ps1 의 wsl.exe 읽기 도우미를 그대로 둔다.
# wsl.exe 는 자기 메시지를 BOM 없는 UTF-16LE 로 쓰고, Stop 모드에서 stderr 를 리디렉션하면
# 첫 줄에서 NativeCommandError 로 끝나므로 바이트로 읽어 NUL 유무로 인코딩을 판별한다.
function Quote-Argument([string]$Value) {
  if ($Value -match '^[A-Za-z0-9_./:=+-]+$') { return $Value }
  return '"' + ([regex]::Replace(([regex]::Replace($Value, '(\\*)"', '$1$1\"')), '(\\+)$', '$1$1')) + '"'
}
function Decode-WslText([byte[]]$Bytes) {
  if ($Bytes.Length -eq 0) { return '' }
  $encoding = if ([Array]::IndexOf($Bytes, [byte]0) -ge 0) { [Text.Encoding]::Unicode } else { New-Object Text.UTF8Encoding $false }
  return $encoding.GetString($Bytes).TrimStart([char]0xFEFF)
}
function Invoke-Wsl([string[]]$Arguments) {
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = 'wsl.exe'
  $info.Arguments = (($Arguments | ForEach-Object { Quote-Argument $_ }) -join ' ')
  $info.UseShellExecute = $false; $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  $process = [Diagnostics.Process]::Start($info)
  $stdout = New-Object IO.MemoryStream; $stderr = New-Object IO.MemoryStream
  $errorCopy = $process.StandardError.BaseStream.CopyToAsync($stderr)
  $process.StandardOutput.BaseStream.CopyTo($stdout)
  $errorCopy.Wait(); $process.WaitForExit()
  return @{ ExitCode=$process.ExitCode; Output=(Decode-WslText $stdout.ToArray()); Error=(Decode-WslText $stderr.ToArray()) }
}
function Get-WslLines([string]$Text) { return @($Text -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
function Resolve-WslInstallLocation($Drive, $Location, $Distribution) {
  if ($Drive -and $Location) { throw '-InstallDrive 와 -InstallLocation 중 하나만 지정한다.' }
  if ($Drive) {
    if ($Distribution -notmatch '^[A-Za-z0-9._-]+$') { throw '배포판 이름에 경로 문자를 사용할 수 없다.' }
    $Location = "$($Drive.TrimEnd(':').ToUpperInvariant()):\WSL\$Distribution"
  }
  if (-not $Location) { return $null }
  if ($Location -notmatch '^[A-Za-z]:\\' -or $Location -match '[<>"|?*\x00-\x1f]' -or $Location.Substring(2).Contains(':')) {
    throw '설치 위치는 D:\WSL\Ubuntu 같은 로컬 드라이브의 절대 경로로 지정한다.'
  }
  $full = [IO.Path]::GetFullPath($Location).TrimEnd('\')
  $root = [IO.Path]::GetPathRoot($full + '\')
  if ($full -eq $root.TrimEnd('\')) { throw '드라이브 루트 대신 Ubuntu 전용 폴더를 지정한다.' }
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw "드라이브가 없다: $root" }
  return $full
}

function Get-WslDriveOptions {
  foreach ($disk in [IO.DriveInfo]::GetDrives()) {
    if ($disk.IsReady -and $disk.DriveType -eq [IO.DriveType]::Fixed -and $disk.Name -match '^[A-Za-z]:\\$') {
      [pscustomobject]@{ Drive = $disk.Name.Substring(0, 1); FreeGB = [math]::Round($disk.AvailableFreeSpace / 1GB, 1) }
    }
  }
}

function Select-WslInstallLocation($Distribution, $CurrentLocation, $Drive, $Location) {
  $disks = @(Get-WslDriveOptions | Sort-Object Drive)
  Write-Host "`nUbuntu 저장 위치를 선택한다." -ForegroundColor Cyan
  if ($CurrentLocation) { Write-Host "  1. 기존 Ubuntu 위치 유지: $CurrentLocation" }
  else { Write-Host '  1. Windows 기본 위치' }
  for ($i = 0; $i -lt $disks.Count; $i++) {
    Write-Host "  $($i + 2). $($disks[$i].Drive):\WSL\$Distribution (여유 $($disks[$i].FreeGB) GB)"
  }
  $custom = $disks.Count + 2
  Write-Host "  $custom. 폴더 직접 지정"
  Write-Host '  Q. 취소'
  if ($CurrentLocation) { Write-Host '  기존 Ubuntu는 자동 이동하지 않는다. 다른 위치를 고르면 불일치를 안내하고 중단한다.' }
  if ($Drive -or $Location) {
    $selected = Resolve-WslInstallLocation $Drive $Location $Distribution
    Write-Host "명령 인자로 선택한 위치: $selected"
    return $selected
  }
  while ($true) {
    try { $answer = Read-Host '번호 입력 (자동 기본값 없음)' }
    catch { throw '위치 선택 입력을 받을 수 없다. -InstallDrive 또는 -InstallLocation으로 선택을 전달한다.' }
    if ($answer -match '^[Qq]$') { throw '사용자가 설치를 취소했다.' }
    $number = 0
    if (-not [int]::TryParse($answer, [ref]$number) -or $number -lt 1 -or $number -gt $custom) {
      Write-Host '표시된 번호 또는 Q를 입력한다.'
      continue
    }
    if ($number -eq 1) { return $null }
    if ($number -eq $custom) {
      $folder = Read-Host 'Ubuntu 전용 폴더의 절대 경로 (예: D:\WSL\Ubuntu)'
      if ([string]::IsNullOrWhiteSpace($folder)) { Write-Host '빈 경로는 선택할 수 없다.'; continue }
      try { return (Resolve-WslInstallLocation '' $folder $Distribution) }
      catch { Write-Host $_.Exception.Message; continue }
    }
    return (Resolve-WslInstallLocation $disks[$number - 2].Drive '' $Distribution)
  }
}

function Get-WslInstallLocation($Distribution) {
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
  if (Test-Path $key) {
    foreach ($entry in Get-ChildItem $key) {
      if ($entry.GetValue('DistributionName') -eq $Distribution) {
        return ([string]$entry.GetValue('BasePath') -replace '^\\\\\?\\', '').TrimEnd('\')
      }
    }
  }
  return $null
}

function Assert-WslInstallLocation($Requested, $Actual) {
  if ($Requested -and (-not $Actual -or $Requested.TrimEnd('\') -ine $Actual.TrimEnd('\'))) {
    throw "Ubuntu 위치가 요청과 다르거나 확인할 수 없다. 요청: '$Requested', 현재: '$Actual'. 기존 배포판은 자동 이동하지 않는다. 현재 위치를 사용하려면 위치 옵션 없이 재실행한다."
  }
}

function Get-WslInstallArguments($Distribution, $Location, $HelpText) {
  $arguments = @('--install', '--no-launch', '-d', $Distribution)
  if ($Location) {
    if ($HelpText -notmatch '--location\b') {
      throw '현재 WSL은 --location을 지원하지 않는다. wsl --update 후 같은 옵션으로 재실행한다. WSL 자체가 없으면 wsl --install --no-distribution 후 필요한 재부팅을 먼저 한다.'
    }
    if (Test-Path -LiteralPath $Location) {
      if (-not (Test-Path -LiteralPath $Location -PathType Container) -or
          @(Get-ChildItem -LiteralPath $Location -Force).Count -gt 0) {
        throw "설치 대상은 비어 있는 전용 폴더여야 한다: $Location"
      }
    }
    $arguments += @('--location', $Location)
  }
  return $arguments
}

# Windows 사용자명은 공백·대문자·한글이 들어갈 수 있어 리눅스 사용자명으로 못 쓴다.
$User = ($User.ToLower() -replace '[^a-z0-9_-]', '')
if ($User -notmatch '^[a-z_][a-z0-9_-]{0,31}$') {
  throw "리눅스 사용자명으로 쓸 수 없다: '$User'. -User <이름> 으로 직접 준다."
}

$admin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw "관리자 권한 PowerShell 에서 실행한다." }

# ---------------------------------------------------------------- WSL
Step "WSL / $Distro"
$installed = Get-WslLines (Invoke-Wsl @('-l','-q')).Output
$currentLocation = if ($installed -contains $Distro) { Get-WslInstallLocation $Distro } else { $null }
$requestedLocation = Select-WslInstallLocation $Distro $currentLocation $InstallDrive $InstallLocation
if ($installed -contains $Distro) {
  $actualLocation = Get-WslInstallLocation $Distro
  Assert-WslInstallLocation $requestedLocation $actualLocation
  Ok "$Distro 이미 설치됨 — 저장 위치: $actualLocation"
} else {
  $wslHelp = if ($requestedLocation) { (Invoke-Wsl @('--help')).Output } else { '' }
  $installArguments = @(Get-WslInstallArguments $Distro $requestedLocation $wslHelp)
  if ($requestedLocation) { Step "Ubuntu 저장 위치: $requestedLocation" }
  else { Step 'Ubuntu 저장 위치: Windows 기본 위치' }
  # cloud-init 을 첫 부팅 전에 깔아둬야 사용자명/비밀번호 대화형 프롬프트가 뜨지 않는다.
  Step "cloud-init (무인 사용자 생성)"
  $ciDir = Join-Path $env:USERPROFILE '.cloud-init'
  New-Item -ItemType Directory -Force -Path $ciDir | Out-Null
  # cloud-init 은 '#cloud-config' 가 첫 바이트여야 한다.
  # Set-Content -Encoding UTF8 은 PowerShell 5.1 에서 BOM 을 붙여 이 검사를 깬다.
  # sudo NOPASSWD: cloud-init 사용자는 비밀번호가 없어 이게 없으면 sudo 자체가 막힌다.
  $userData = @"
#cloud-config
users:
  - name: $User
    groups: [adm, sudo]
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash

"@ -replace "`r`n", "`n"
  $ciPath = Join-Path $ciDir "$Distro.user-data"
  [System.IO.File]::WriteAllText($ciPath, $userData,
    (New-Object System.Text.UTF8Encoding $false))

  $head = [System.IO.File]::ReadAllBytes($ciPath)[0..2] -join ' '
  if ($head -eq '239 187 191') { throw "user-data 에 BOM 이 붙었다. cloud-init 이 무시한다." }
  Ok "$Distro.user-data 작성 (BOM 없음 확인)"

  Step "$Distro 설치"
  wsl.exe @installArguments
  if ($LASTEXITCODE -ne 0) {
    Warn "WSL 기능이 방금 켜졌을 수 있다. 재부팅 후 이 스크립트를 다시 실행한다."
    exit 1
  }
  $actualLocation = Get-WslInstallLocation $Distro
  Assert-WslInstallLocation $requestedLocation $actualLocation
  Ok "Ubuntu 저장 위치 확인: $actualLocation"
  wsl.exe -d $Distro -- true    # 첫 부팅 → cloud-init 실행
  if ($LASTEXITCODE -ne 0) { throw "$Distro 첫 부팅에 실패했다 (exit $LASTEXITCODE)." }
  Ok "$Distro 설치 및 초기화"

  # cloud-init 이 조용히 무시되면 여기서 드러난다. 다음 단계로 넘기지 않는다.
  if ((Invoke-Wsl @('-d',$Distro,'--','id','-u',$User)).ExitCode -ne 0) {
    throw "cloud-init 이 사용자 '$User' 를 만들지 못했다. " +
          "'wsl -d $Distro' 로 직접 들어가 사용자를 만든 뒤 linux/setup.sh 를 돌린다."
  }
  Ok "사용자 '$User' 확인"
}

# 기존 배포판도 지정 사용자를 확인한 뒤 Linux 설정으로 진입한다.
if ((Invoke-Wsl @('-d',$Distro,'--','id','-u',$User)).ExitCode -ne 0) {
  throw "배포판 '$Distro' 에 사용자 '$User' 가 없다. -User 에 기존 Linux 사용자명을 지정한다."
}

# ---------------------------------------------------------------- Orca
Step "Orca"
$orcaExe = Join-Path $env:LOCALAPPDATA 'Programs\orca\resources\bin\orca.exe'
if (Test-Path $orcaExe) {
  Ok "이미 설치됨"
} else {
  # Orca 는 winget 패키지가 아니라 배포용 인스톨러다. 링크는 배포처에서 받는다.
  Warn "Orca 미설치 — 설치 후 WSL 터미널을 한 번 열면 ~/.local/bin/orca-ide 브리지가 생긴다."
}

# ---------------------------------------------------------------- 리눅스 쪽
Step "$Distro 안에서 setup.sh 실행"
$sh = @"
set -e
mkdir -p ~/dev
if [ ! -d ~/dev/dev-bootstrap/.git ]; then git clone -q $Repo ~/dev/dev-bootstrap; fi
bash ~/dev/dev-bootstrap/linux/setup.sh
"@ -replace "`r`n","`n"
if ($ConfigFile) {
  $resolvedConfig = (Resolve-Path -LiteralPath $ConfigFile).Path
  $converted = Invoke-Wsl @('-d',$Distro,'-u',$User,'--','wslpath','-a',$resolvedConfig)
  if ($converted.ExitCode -ne 0) { throw '설정 파일 경로 변환 실패' }
  $linuxConfig = $converted.Output.Trim()
  $sh = $sh.Replace('bash ~/dev/dev-bootstrap/linux/setup.sh', 'bash ~/dev/dev-bootstrap/linux/setup.sh --config "$1"')
  wsl.exe -d $Distro -u $User -- bash -lc $sh bootstrap $linuxConfig
} else {
  wsl.exe -d $Distro -u $User -- bash -lc $sh
}
# setup.sh 는 검증에 실패하면 0 이 아닌 코드로 끝난다. 그걸 확인하지 않으면
# 리눅스 쪽이 반쯤 실패했는데 Windows 는 "완료" 라고 말한다.
if ($LASTEXITCODE -ne 0) {
  Warn "setup.sh 에 미완료 항목이 있다 (exit $LASTEXITCODE). 마지막 목록과 단계 안내를 확인한다."
  Warn "로그: \\wsl.localhost\$Distro\home\$User\.local\state\dev-bootstrap\events.log"
  Warn "고친 뒤 다시 돌린다: wsl -d $Distro -u $User -- bash ~/dev/dev-bootstrap/linux/setup.sh"
  exit $LASTEXITCODE
}

Write-Host "`n완료. 남은 것: claude / codex login / gh auth login / Orca 계정 로그인" -ForegroundColor Cyan
