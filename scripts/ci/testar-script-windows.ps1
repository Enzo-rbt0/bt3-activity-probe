<#
  Teste do criar-arquivo-teste.ps1 no Windows (CI, job "script-windows", Windows PowerShell 5.1).
  Tudo acontece em pastas temporárias do runner, apagadas no fim. O arquivo de 3 GiB é esparso e
  nunca vira artefato.
#>
$ErrorActionPreference = 'Stop'
$script = Join-Path $env:GITHUB_WORKSPACE 'scripts\criar-arquivo-teste.ps1'
$tmp = Join-Path $env:RUNNER_TEMP ('bt3probe-ps1-' + [guid]::NewGuid())
$tmp2 = Join-Path $env:RUNNER_TEMP ('bt3probe-ps1-falso-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp, $tmp2 | Out-Null
$nome = 'teste.bt3probe-large.bin'
$arq = Join-Path $tmp $nome
[long]$tam = 3GB
[long]$apos = 2147483648 + 1048576
$script:falhas = 0

function Falha([string]$m) { Write-Host "FALHOU: $m" -ForegroundColor Red; $script:falhas++ }
function Ok([string]$m) { Write-Host "ok $m" -ForegroundColor Green }
function Rodar([string[]]$argumentos) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $script @argumentos | Out-Host
  return $LASTEXITCODE
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Bt3CiFisico {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern uint GetCompressedFileSizeW(string path, out uint high);
  public static long Size(string path) { uint h; uint l = GetCompressedFileSizeW(path, out h); return ((long)h << 32) + l; }
}
'@

function Ler-Em([string]$p, [long]$pos) {
  $fs = [System.IO.File]::Open($p, 'Open', 'Read', 'ReadWrite')
  try {
    [void]$fs.Seek($pos, 'Begin')
    $buf = New-Object byte[] 64
    $n = $fs.Read($buf, 0, 64)
    return [System.Text.Encoding]::ASCII.GetString($buf, 0, $n)
  } finally { $fs.Dispose() }
}

try {
  # 1. Criar
  $c = Rodar @('-Pasta', $tmp)
  if ($c -ne 0) { Falha "criar terminou com código $c" } else { Ok 'criou o arquivo' }
  if (-not (Test-Path -LiteralPath $arq)) { throw 'arquivo não foi criado; os demais testes não fazem sentido' }

  # 2. Tamanho lógico, atributo esparso e espaço físico
  $item = Get-Item -LiteralPath $arq
  if ($item.Length -ne $tam) { Falha "tamanho lógico $($item.Length), esperado $tam" } else { Ok 'tamanho lógico = 3 GiB' }
  if (-not ($item.Attributes -band [System.IO.FileAttributes]::SparseFile)) { Falha 'arquivo não está marcado como esparso' } else { Ok 'atributo esparso presente' }
  $fis = [Bt3CiFisico]::Size($arq)
  Write-Host ("  espaço físico: {0:N0} KiB" -f [math]::Ceiling($fis / 1KB))
  if ($fis -gt 64MB) { Falha "espaço físico $fis bytes passa de 64 MiB" } else { Ok 'espaço físico abaixo de 64 MiB' }

  # 3. Marcadores nas 3 posições
  foreach ($pos in @([long]0, $apos, ($tam - 4096))) {
    $txt = Ler-Em $arq $pos
    if (-not $txt.StartsWith("BT3PROBE-MARK:$pos;")) { Falha "marcador errado na posição $pos ('$txt')" } else { Ok "marcador na posição $pos" }
  }

  # 4. Rodar de novo não sobrescreve
  $antes = (Get-Item -LiteralPath $arq).LastWriteTimeUtc
  $c = Rodar @('-Pasta', $tmp)
  if ($c -eq 0) { Falha 'segunda execução deveria recusar (arquivo já existe)' } else { Ok 'segunda execução recusou' }
  if ((Get-Item -LiteralPath $arq).LastWriteTimeUtc -ne $antes) { Falha 'o arquivo foi alterado pela segunda execução' } else { Ok 'arquivo existente não foi alterado' }

  # 5. -Apagar recusa arquivo com o nome certo e conteúdo errado
  $falso = Join-Path $tmp2 $nome
  [System.IO.File]::WriteAllText($falso, 'isto nao e o arquivo de teste')
  $c = Rodar @('-Pasta', $tmp2, '-Apagar')
  if ($c -eq 0 -or -not (Test-Path -LiteralPath $falso)) { Falha '-Apagar apagou (ou aceitou) um arquivo sem o marcador' } else { Ok '-Apagar recusou arquivo sem marcador' }

  # 6. Recusa pasta dentro de repositório git
  $c = Rodar @('-Pasta', $env:GITHUB_WORKSPACE)
  if ($c -eq 0 -or (Test-Path -LiteralPath (Join-Path $env:GITHUB_WORKSPACE $nome))) { Falha 'criou dentro do repositório' } else { Ok 'recusou pasta dentro do repositório' }

  # 7. -Apagar de verdade
  $c = Rodar @('-Pasta', $tmp, '-Apagar')
  if ($c -ne 0 -or (Test-Path -LiteralPath $arq)) { Falha '-Apagar não apagou o arquivo de teste' } else { Ok '-Apagar apagou e o arquivo não existe mais' }
  $c = Rodar @('-Pasta', $tmp, '-Apagar')
  if ($c -ne 0) { Falha '-Apagar sem arquivo deveria terminar sem erro' } else { Ok '-Apagar sem arquivo: nada a apagar' }
} catch {
  Falha $_.Exception.Message
} finally {
  Remove-Item -LiteralPath $tmp, $tmp2 -Recurse -Force -ErrorAction SilentlyContinue
  if ((Test-Path -LiteralPath $tmp) -or (Test-Path -LiteralPath $tmp2)) { Falha 'pastas temporárias não foram apagadas' }
  if (Test-Path -LiteralPath (Join-Path $env:GITHUB_WORKSPACE $nome)) {
    Remove-Item -LiteralPath (Join-Path $env:GITHUB_WORKSPACE $nome) -Force -ErrorAction SilentlyContinue
  }
}

if ($script:falhas -gt 0) { Write-Host "script-windows: $($script:falhas) falha(s)"; exit 1 }
Write-Host 'script-windows: tudo certo'
