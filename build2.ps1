$ErrorActionPreference = 'Continue'
$root = 'C:\Users\Administrator\Desktop\agent cowork'
$log = "$root\build2.log"; $done = "$root\build2.done"
Remove-Item $log,$done -Force -ErrorAction SilentlyContinue
function Log($m) { "$([DateTime]::Now.ToString('HH:mm:ss')) $m" | Out-File $log -Append -Encoding utf8 }
function Fail($s){ Log "FAIL: $s"; "FAIL_$s" | Out-File $done -Encoding ascii; exit 1 }

Log 'STEP 1 vite ui-dist (chatEnabled self-heal)'
Set-Location $root; node scripts/build-ui.mjs *>> $log; if($LASTEXITCODE -ne 0){Fail 'ui'}
Log 'STEP 2 esbuild + SEA blob (CORS tauri.localhost)'
Set-Location "$root\apps\windows-client\ui"; node build-host-sea.mjs *>> $log; if($LASTEXITCODE -ne 0){Fail 'esbuild'}
Set-Location "$root\apps\host"; node --experimental-sea-config sea-config.json *>> $log
if (-not (Test-Path "$root\apps\host\dist\host.blob")){Fail 'blob'}
Log 'STEP 3 postject'
$target = "$root\apps\windows-client\src-tauri\binaries\agent-cowork-host-x86_64-pc-windows-msvc.exe"
Copy-Item 'C:\Program Files\nodejs\node.exe' $target -Force
Set-Location "$root\apps\windows-client\ui"
npx --no-install postject $target NODE_SEA_BLOB "$root\apps\host\dist\host.blob" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite *>> $log
Log 'STEP 4 cargo tauri build'
Set-Location "$root\apps\windows-client"; cargo tauri build *>> $log; if($LASTEXITCODE -ne 0){Fail 'tauri'}
Log 'STEP 5 copy + sign'
$base="$root\apps\windows-client\src-tauri\target\release\bundle"; $dest="$root\installers"
Remove-Item "$dest\*" -Force -ErrorAction SilentlyContinue
Copy-Item "$base\msi\Agent Cowork_0.1.0_x64_en-US.msi" $dest -Force
Copy-Item "$base\nsis\Agent Cowork_0.1.0_x64-setup.exe" $dest -Force
& pwsh -NoProfile -ExecutionPolicy Bypass -File "$root\scripts\sign-windows.ps1" -SelfSigned *>> $log
Log 'STEP 6 host test suite'
Set-Location "$root\apps\host"
node --test --test-isolation=process --test-timeout=60000 --import ../../test-setup.mjs "test/*.test.js" > "$root\build2-host.log" 2>&1
Log "host exit=$LASTEXITCODE"
Log 'STEP 7 ui test suite'
Set-Location "$root\apps\windows-client\ui"; npm test > "$root\build2-ui.log" 2>&1
Log "ui exit=$LASTEXITCODE"
Log 'BUILD OK'
"DONE" | Out-File $done -Encoding ascii
