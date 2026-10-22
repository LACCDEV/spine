# Minimaler statischer Webserver für Windows – ohne Node, Python oder Adminrechte.
# Liefert den Projektordner über http://localhost aus (sicherer Kontext für die Kamera,
# ES-Module mit korrektem MIME-Typ). Nur von diesem Rechner aus erreichbar (Loopback).
#
#   powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 8090] [-Open]
#   oder einfach start.cmd doppelklicken.  Beenden: Fenster schließen oder Strg+C.
param(
  [int]$Port = 8090,
  [string]$Root = $PSScriptRoot,
  [switch]$Open
)

$ErrorActionPreference = "Stop"

$mime = @{
  ".html" = "text/html; charset=utf-8"
  ".js"   = "text/javascript; charset=utf-8"
  ".mjs"  = "text/javascript; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".md"   = "text/markdown; charset=utf-8"
  ".svg"  = "image/svg+xml"
  ".png"  = "image/png"
  ".ico"  = "image/x-icon"
  ".wasm" = "application/wasm"
  ".task" = "application/octet-stream"
}

$rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

try {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
  $listener.Start()
} catch {
  Write-Host "Port $Port ist belegt. Anderen Port wählen, z. B.: serve.ps1 -Port 8091" -ForegroundColor Yellow
  exit 1
}
$url = "http://localhost:$Port/"
Write-Host "Bandscheiben in Bewegung läuft auf $url" -ForegroundColor Green
Write-Host "Zum Beenden dieses Fenster schließen (oder Strg+C)."
if ($Open) { Start-Process $url }

while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    # Zeitlimit, damit ein „Vorab-Verbindungs“-Socket ohne Anfrage den Server nicht blockiert.
    $client.ReceiveTimeout = 4000
    $stream = $client.GetStream()
    $stream.ReadTimeout = 4000
    $reader = [System.IO.StreamReader]::new($stream)
    $requestLine = $reader.ReadLine()
    if (-not $requestLine) { $client.Close(); continue }

    $parts = $requestLine.Split(" ")
    $path = if ($parts.Length -ge 2) { $parts[1] } else { "/" }
    $path = [System.Uri]::UnescapeDataString($path.Split("?")[0])
    if ($path.EndsWith("/")) { $path += "index.html" }

    # Nur Dateien unterhalb des Projektordners ausliefern.
    $relative = $path.TrimStart("/").Replace("/", [IO.Path]::DirectorySeparatorChar)
    $full = [IO.Path]::GetFullPath((Join-Path $rootFull $relative))

    $writer = [System.IO.BinaryWriter]::new($stream)
    if (-not $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
      $body = [Text.Encoding]::UTF8.GetBytes("404 Not Found: $path")
      $head = "HTTP/1.1 404 Not Found`r`nContent-Type: text/plain; charset=utf-8`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
      $writer.Write([Text.Encoding]::ASCII.GetBytes($head))
      $writer.Write($body)
    } else {
      $ext = [IO.Path]::GetExtension($full).ToLower()
      $ct = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { "application/octet-stream" }
      $bytes = [IO.File]::ReadAllBytes($full)
      $head = "HTTP/1.1 200 OK`r`nContent-Type: $ct`r`nContent-Length: $($bytes.Length)`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
      $writer.Write([Text.Encoding]::ASCII.GetBytes($head))
      $writer.Write($bytes)
    }
    $writer.Flush()
  } catch {
    Write-Host "Fehler: $($_.Exception.Message)"
  } finally {
    $client.Close()
  }
}
