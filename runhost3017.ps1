$root = 'C:\Users\Administrator\Desktop\agent cowork'
Set-Location $root
Get-Content "$root\.env" | ForEach-Object {
  if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$' -and $_ -notmatch '^\s*#') {
    Set-Item -Path "env:$($matches[1])" -Value $matches[2]
  }
}
$env:PORT = '3017'
$env:TRUSTED_ROOT = $root
node apps/host/src/main.js *> "$root\runhost3017.log"
