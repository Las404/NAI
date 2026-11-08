# 로컬 미리보기용 정적 서버 (Node/Python 없이 PowerShell만으로 실행)
# 사용법: powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 5173]
param([int]$Port = 5173)
$root = $PSScriptRoot
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'; '.png' = 'image/png'; '.webp' = 'image/webp'; '.svg' = 'image/svg+xml'
  '.ico' = 'image/x-icon'; '.md' = 'text/plain; charset=utf-8'
}
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $root at http://localhost:$Port/"
try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ($path -eq '') { $path = 'index.html' }
    $file = [IO.Path]::GetFullPath((Join-Path $root $path))
    $res = $ctx.Response
    try {
      # 로컬 개발 전용: tools/ 페이지가 계산한 결과를 assets/ 아래에 저장 (PUT /__save/assets/...)
      if ($ctx.Request.HttpMethod -eq 'PUT' -and $path.StartsWith('__save/assets/')) {
        $target = [IO.Path]::GetFullPath((Join-Path $root $path.Substring(7)))
        if ($target.StartsWith((Join-Path $root 'assets'))) {
          New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
          $ms = New-Object IO.MemoryStream
          $ctx.Request.InputStream.CopyTo($ms)
          [IO.File]::WriteAllBytes($target, $ms.ToArray())
          $res.StatusCode = 204
        } else { $res.StatusCode = 403 }
        continue
      }
      if ($file.StartsWith($root) -and (Test-Path $file -PathType Leaf)) {
        $bytes = [IO.File]::ReadAllBytes($file)
        $ext = [IO.Path]::GetExtension($file).ToLower()
        $res.ContentType = if ($types[$ext]) { $types[$ext] } else { 'application/octet-stream' }
        $res.Headers.Add('Cache-Control', 'no-cache')
        $res.ContentLength64 = $bytes.Length
        if ($ctx.Request.HttpMethod -ne 'HEAD') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
      } else {
        $res.StatusCode = 404
      }
    } catch {
      Write-Host "error: $($_.Exception.Message)"
    } finally {
      try { $res.Close() } catch {}
    }
  }
} finally { $listener.Stop() }
