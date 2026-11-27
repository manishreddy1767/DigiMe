<#
.SYNOPSIS
  Install LivePortrait, which turns one photo into the avatar's face poses.
.DESCRIPTION
  Downloads LivePortrait (MIT licence) into models\liveportrait, which git ignores, gives it
  its own Python environment with a CUDA build of PyTorch, and downloads its model files
  (about 630 MB) from Hugging Face. Nothing is uploaded; photos never leave this computer.

  The face-detection models it uses (InsightFace) are for non-commercial use only. Digital Me
  is a personal, private project, which fits that.
.EXAMPLE
  .\scripts\setup-avatar.ps1
#>
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$target = Join-Path $root "models\liveportrait"
$commit = "9b294b3d0536135442ea73cb01e6cb3ca7029dd3"  # the version Digital Me was tested with

foreach ($tool in "git", "uv") {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Error "'$tool' is not installed. See README.md > Setup."
    }
}
# From here on, failures are detected by exit codes: Windows PowerShell would otherwise treat
# the tools' progress messages on stderr as errors.
$ErrorActionPreference = "Continue"
$env:HF_HUB_DISABLE_PROGRESS_BARS = "1"

if (-not (Test-Path "$target\.git")) {
    Write-Host "Downloading LivePortrait..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force $target | Out-Null
    git -C $target init -q
    git -C $target remote add origin https://github.com/KwaiVGI/LivePortrait.git
}
git -C $target fetch -q --depth 1 origin $commit
git -C $target checkout -q $commit
if ($LASTEXITCODE -ne 0) { throw "Could not download LivePortrait" }

Push-Location $target
try {
    Write-Host "Installing its Python environment (PyTorch with CUDA, about 3 GB)..." -ForegroundColor Cyan
    if (-not (Test-Path ".venv")) { uv venv -q --python 3.12 .venv }
    $python = ".venv\Scripts\python.exe"
    uv pip install -q --python $python torch torchvision --index-url https://download.pytorch.org/whl/cu126
    uv pip install -q --python $python "numpy<2" pyyaml opencv-python scipy imageio imageio-ffmpeg tqdm rich `
        onnx onnxruntime-gpu scikit-image tyro pykalman requests pillow "huggingface_hub[cli]"
    if ($LASTEXITCODE -ne 0) { throw "Installing packages failed" }

    Write-Host "Downloading the model files (about 630 MB)..." -ForegroundColor Cyan
    & $python -c "from huggingface_hub import snapshot_download as s; s('KwaiVGI/LivePortrait', local_dir='pretrained_weights', allow_patterns=['insightface/*', 'liveportrait/*'])"
    if ($LASTEXITCODE -ne 0) { throw "Downloading the model files failed" }

    & $python -c "import torch; print('GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'none (rendering will be slow)')"
} finally { Pop-Location }

Write-Host "LivePortrait is ready. Restart Digital Me, then open Context > Your avatar." -ForegroundColor Green
