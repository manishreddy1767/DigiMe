<#
.SYNOPSIS
  Install OpenVoice V2, which lets Digital Me speak in your own voice.
.DESCRIPTION
  Downloads OpenVoice (MIT licence) into models\openvoice, which git ignores, and its voice
  converter (about 130 MB). It runs in the same GPU Python environment as the avatar, so the
  avatar setup runs first if it hasn't yet. Also installs wavmark (MIT), which puts an inaudible
  "AI-made" watermark into every sentence spoken in your voice.

  Nothing is uploaded: your recordings stay in instances\<name>\voice and are processed here.
.EXAMPLE
  .\scripts\setup-voice.ps1
#>
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$gpu = Join-Path $root "models\liveportrait"
$python = Join-Path $gpu ".venv\Scripts\python.exe"
$target = Join-Path $root "models\openvoice"
$commit = "74a1d147b17a8c3092dd5430504bd83ef6c7eb23"  # the version Digital Me was tested with

if (-not (Test-Path $python)) {
    Write-Host "Setting up the GPU environment first (shared with the avatar)..." -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot "setup-avatar.ps1")
}
# From here on, failures are detected by exit codes: Windows PowerShell would otherwise treat
# the tools' progress messages on stderr as errors.
$ErrorActionPreference = "Continue"
$env:HF_HUB_DISABLE_PROGRESS_BARS = "1"

if (-not (Test-Path "$target\.git")) {
    Write-Host "Downloading OpenVoice..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force $target | Out-Null
    git -C $target init -q
    git -C $target remote add origin https://github.com/myshell-ai/OpenVoice.git
}
git -C $target fetch -q --depth 1 origin $commit
git -C $target checkout -q $commit
if ($LASTEXITCODE -ne 0) { throw "Could not download OpenVoice" }

Write-Host "Installing its packages..." -ForegroundColor Cyan
uv pip install -q --python $python librosa "wavmark==0.0.3" soundfile imageio-ffmpeg
if ($LASTEXITCODE -ne 0) { throw "Installing packages failed" }

Write-Host "Downloading the voice converter and the watermark model..." -ForegroundColor Cyan
& $python -c "from huggingface_hub import snapshot_download as s, hf_hub_download as h; s('myshell-ai/OpenVoiceV2', local_dir=r'$target\checkpoints_v2', allow_patterns=['converter/*']); h('M4869/WavMark', 'step59000_snr39.99_pesq4.35_BERP_none0.30_mean1.81_std1.81.model.pkl')"
if ($LASTEXITCODE -ne 0) { throw "Downloading the models failed" }

Write-Host "Your voice is ready to set up. Restart Digital Me, then open Context > Your voice." -ForegroundColor Green
