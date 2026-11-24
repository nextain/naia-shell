param(
    [Parameter(Mandatory = $true)]
    [string]$Avatar,
    [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    throw 'ffmpeg is required.'
}
if (-not (Get-Command ffprobe -ErrorAction SilentlyContinue)) {
    throw 'ffprobe is required.'
}

$MediaRoot = $PSScriptRoot
$SourceDir = Join-Path $MediaRoot 'source'
$SteamDir = Join-Path $MediaRoot 'steam'
$SteamShots = Join-Path $SteamDir 'screenshots'
$MicrosoftDir = Join-Path $MediaRoot 'microsoft-store'
$MicrosoftShots = Join-Path $MicrosoftDir 'screenshots'

@($SourceDir, $SteamDir, $SteamShots, $MicrosoftDir, $MicrosoftShots) | ForEach-Object {
    New-Item -ItemType Directory -Force -Path $_ | Out-Null
}

$Logo = Join-Path $ProjectRoot 'packages\shell\public\brand\naia-logo.png'
$Icon = Join-Path $ProjectRoot 'packages\shell\src-tauri\icons\icon.png'
$Shot1 = Join-Path $ProjectRoot 'packages\shell\_results_\nva-shell-8gb-profile-verified.png'
$Shot2 = Join-Path $ProjectRoot 'packages\shell\_results_\s1-settings-open.png'
$Shot3 = Join-Path $ProjectRoot 'packages\shell\_results_\s2-after-login-click.png'
$Font = 'C\:/Windows/Fonts/segoeuib.ttf'

@($Avatar, $Logo, $Icon, $Shot1, $Shot2, $Shot3) | ForEach-Object {
    if (-not (Test-Path -LiteralPath $_)) { throw "Missing source asset: $_" }
    Copy-Item -LiteralPath $_ -Destination $SourceDir -Force
}

function New-TitleArt {
    param([int]$Width, [int]$Height, [string]$Output, [double]$FontRatio = 0.15)
    $fontSize = [Math]::Max(30, [int]($Height * $FontRatio))
    $filter = "[0:v]scale=${Width}:${Height}:force_original_aspect_ratio=increase,crop=${Width}:${Height},boxblur=18:6[bg];[1:v]scale=-1:$([int]($Height * 0.82))[fg];[bg][fg]overlay=$([int]($Width * 0.55)):(H-h)/2,drawbox=x=0:y=0:w=$([int]($Width * 0.58)):h=H:color=0x04101c@0.72:t=fill,drawtext=fontfile='$Font':text='NAIA':fontcolor=white:fontsize=$fontSize:x=$([int]($Width * 0.08)):y=(H-text_h)/2"
    & ffmpeg -hide_banner -loglevel error -y -i $Avatar -i $Avatar -filter_complex $filter -frames:v 1 $Output
}

function New-NoTextArt {
    param([int]$Width, [int]$Height, [string]$Output)
    & ffmpeg -hide_banner -loglevel error -y -i $Avatar -vf "scale=${Width}:${Height}:force_original_aspect_ratio=increase,crop=${Width}:${Height}" -frames:v 1 $Output
}

function New-Screenshot {
    param([string]$Input, [string]$Output)
    & ffmpeg -hide_banner -loglevel error -y -i $Input -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x060d14" -frames:v 1 $Output
}

New-TitleArt 920 430 (Join-Path $SteamDir 'header_capsule.png')
New-TitleArt 462 174 (Join-Path $SteamDir 'small_capsule.png') 0.20
New-TitleArt 1232 706 (Join-Path $SteamDir 'main_capsule.png')
New-TitleArt 748 896 (Join-Path $SteamDir 'vertical_capsule.png') 0.12
New-TitleArt 600 900 (Join-Path $SteamDir 'library_capsule.png') 0.12
New-TitleArt 920 430 (Join-Path $SteamDir 'library_header.png')
New-NoTextArt 3840 1240 (Join-Path $SteamDir 'library_hero.png')

$logoFilter = "[1:v]scale=250:250[logo];[0:v][logo]overlay=80:235,drawtext=fontfile='$Font':text='NAIA':fontcolor=white:fontsize=190:x=390:y=(H-text_h)/2"
& ffmpeg -hide_banner -loglevel error -y -f lavfi -i "color=c=black@0.0:s=1280x720,format=rgba" -i $Logo -filter_complex $logoFilter -frames:v 1 (Join-Path $SteamDir 'library_logo.png')

New-Screenshot $Shot1 (Join-Path $SteamShots '01-main-nva.png')
New-Screenshot $Shot2 (Join-Path $SteamShots '02-settings.png')
New-Screenshot $Shot3 (Join-Path $SteamShots '03-account.png')

New-TitleArt 1080 1080 (Join-Path $MicrosoftDir 'box_art_1080.png') 0.13
New-TitleArt 1440 2160 (Join-Path $MicrosoftDir 'poster_art_1440x2160.png') 0.10
& ffmpeg -hide_banner -loglevel error -y -i $Icon -vf 'scale=300:300' -frames:v 1 (Join-Path $MicrosoftDir 'app_tile_300.png')
New-NoTextArt 1920 1080 (Join-Path $MicrosoftDir 'super_hero_1920x1080.png')
New-Screenshot $Shot1 (Join-Path $MicrosoftShots '01-main-nva.png')
New-Screenshot $Shot2 (Join-Path $MicrosoftShots '02-settings.png')
New-Screenshot $Shot3 (Join-Path $MicrosoftShots '03-account.png')

$Expected = @(
    @((Join-Path $SteamDir 'header_capsule.png'), 920, 430),
    @((Join-Path $SteamDir 'small_capsule.png'), 462, 174),
    @((Join-Path $SteamDir 'main_capsule.png'), 1232, 706),
    @((Join-Path $SteamDir 'vertical_capsule.png'), 748, 896),
    @((Join-Path $SteamDir 'library_capsule.png'), 600, 900),
    @((Join-Path $SteamDir 'library_header.png'), 920, 430),
    @((Join-Path $SteamDir 'library_hero.png'), 3840, 1240),
    @((Join-Path $SteamDir 'library_logo.png'), 1280, 720),
    @((Join-Path $MicrosoftDir 'box_art_1080.png'), 1080, 1080),
    @((Join-Path $MicrosoftDir 'poster_art_1440x2160.png'), 1440, 2160),
    @((Join-Path $MicrosoftDir 'app_tile_300.png'), 300, 300),
    @((Join-Path $MicrosoftDir 'super_hero_1920x1080.png'), 1920, 1080)
)

foreach ($item in $Expected) {
    $dimensions = (& ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 $item[0]).Trim()
    $wanted = "$($item[1])x$($item[2])"
    if ($dimensions -ne $wanted) { throw "Dimension mismatch: $($item[0]) is $dimensions, expected $wanted" }
}

Write-Host "Store assets generated and dimension-checked under $MediaRoot"
