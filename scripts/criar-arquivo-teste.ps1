<#
.SYNOPSIS
  Cria (ou apaga) o arquivo de teste da F2b para o A-FILE-LARGE: 3 GiB, com 3 marcadores de texto
  em posições conhecidas. Não tem nada do BT3.

.DESCRIPTION
  Cuidados (revisão da F2b):
    - Não usa fsutil e não precisa de administrador. Marca o arquivo como esparso pela API do
      Windows (DeviceIoControl + FSCTL_SET_SPARSE) no arquivo recém-criado pelo próprio usuário.
    - Nunca sobrescreve: se o arquivo já existir, para.
    - Recusa criar dentro de um repositório git (o arquivo nunca vai para o GitHub; além disso,
      *.bt3probe-large.bin está no .gitignore).
    - Confere o sistema de arquivos (NTFS ou ReFS) e o espaço livre ANTES.
    - Mede o espaço físico realmente ocupado logo depois de definir o tamanho. Se passar de
      64 MiB (ou seja, o modo esparso não funcionou), apaga e cancela. Nunca ocupa 3 GiB sozinho.
    - -Apagar só apaga um arquivo com o nome certo E com o marcador certo no início.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\criar-arquivo-teste.ps1
  (o -ExecutionPolicy Bypass vale só para esta execução; não muda nada no Windows)

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\criar-arquivo-teste.ps1 -Apagar
#>
[CmdletBinding()]
param(
  [string]$Pasta = (Join-Path $env:USERPROFILE 'Downloads'),
  [switch]$Apagar
)

$ErrorActionPreference = 'Stop'
$Nome = 'teste.bt3probe-large.bin'
[long]$Tamanho = 3GB                       # 3.221.225.472 bytes
[long]$Apos2GiB = 2147483648 + 1048576     # 2 GiB + 1 MiB = 2.148.532.224
[long]$LimiteFisico = 64MB
[long]$EspacoMinimo = 256MB
$Marcador0 = 'BT3PROBE-MARK:0;'

if (-not (Test-Path -LiteralPath $Pasta -PathType Container)) {
  Write-Host "ERRO: a pasta '$Pasta' não existe." -ForegroundColor Red
  exit 1
}
$Pasta = (Resolve-Path -LiteralPath $Pasta).Path
$Caminho = Join-Path $Pasta $Nome

function Ler-Inicio([string]$p) {
  $fs = [System.IO.File]::Open($p, 'Open', 'Read', 'ReadWrite')
  try {
    $buf = New-Object byte[] 64
    $n = $fs.Read($buf, 0, 64)
    return [System.Text.Encoding]::ASCII.GetString($buf, 0, $n)
  } finally { $fs.Dispose() }
}

# ---------- Apagar ----------
if ($Apagar) {
  if (-not (Test-Path -LiteralPath $Caminho -PathType Leaf)) {
    Write-Host "Nada a apagar: '$Caminho' não existe."
    exit 0
  }
  if (-not (Ler-Inicio $Caminho).StartsWith($Marcador0)) {
    Write-Host "ERRO: '$Caminho' não tem o marcador do arquivo de teste. Não apaguei nada." -ForegroundColor Red
    exit 1
  }
  Remove-Item -LiteralPath $Caminho
  Write-Host "Apagado: $Caminho" -ForegroundColor Green
  exit 0
}

# ---------- Criar: conferências antes ----------
if (Test-Path -LiteralPath $Caminho) {
  Write-Host "ERRO: '$Caminho' já existe. Nada foi alterado. Para recriar, rode antes com -Apagar." -ForegroundColor Red
  exit 1
}

$d = Get-Item -LiteralPath $Pasta
while ($d) {
  if (Test-Path -LiteralPath (Join-Path $d.FullName '.git')) {
    Write-Host "ERRO: '$Pasta' fica dentro de um repositório git ($($d.FullName)). Escolha outra pasta com -Pasta." -ForegroundColor Red
    exit 1
  }
  $d = $d.Parent
}

$drive = New-Object System.IO.DriveInfo ([System.IO.Path]::GetPathRoot($Pasta))
if (@('NTFS', 'ReFS') -notcontains $drive.DriveFormat) {
  Write-Host "ERRO: o disco usa '$($drive.DriveFormat)', que não garante arquivo esparso. Cancelado sem criar nada." -ForegroundColor Red
  exit 1
}
if ($drive.AvailableFreeSpace -lt $EspacoMinimo) {
  Write-Host ("ERRO: só {0:N0} MiB livres; preciso de pelo menos {1:N0} MiB de folga. Cancelado." -f ($drive.AvailableFreeSpace / 1MB), ($EspacoMinimo / 1MB)) -ForegroundColor Red
  exit 1
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class Bt3ProbeSparse {
  public const uint FSCTL_SET_SPARSE = 0x000900C4;
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool DeviceIoControl(SafeFileHandle h, uint code, IntPtr inBuf, uint inSize,
    IntPtr outBuf, uint outSize, out uint returned, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern uint GetCompressedFileSizeW(string path, out uint high);
  public static void SetSparse(SafeFileHandle h) {
    uint r;
    if (!DeviceIoControl(h, FSCTL_SET_SPARSE, IntPtr.Zero, 0, IntPtr.Zero, 0, out r, IntPtr.Zero))
      throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  // Espaço realmente ocupado no disco (para arquivo esparso, só as partes gravadas).
  public static long PhysicalSize(string path) {
    uint high;
    uint low = GetCompressedFileSizeW(path, out high);
    if (low == 0xFFFFFFFF) {
      int err = Marshal.GetLastWin32Error();
      if (err != 0) throw new Win32Exception(err);
    }
    return ((long)high << 32) + low;
  }
}
'@

function Escrever-Marcador($fs, [long]$pos) {
  $b = [System.Text.Encoding]::ASCII.GetBytes("BT3PROBE-MARK:$pos;")
  [void]$fs.Seek($pos, 'Begin')
  $fs.Write($b, 0, $b.Length)
}

# ---------- Criar ----------
$fs = $null
try {
  # CreateNew: falha se o arquivo aparecer entre a conferência e agora (nunca sobrescreve).
  $fs = [System.IO.File]::Open($Caminho, 'CreateNew', 'ReadWrite', 'Read')
  [Bt3ProbeSparse]::SetSparse($fs.SafeFileHandle)
  $fs.SetLength($Tamanho)
  $fs.Flush()
  $fisico = [Bt3ProbeSparse]::PhysicalSize($Caminho)
  if ($fisico -gt $LimiteFisico) {
    throw ("o modo esparso não funcionou: o arquivo já ocupa {0:N0} MiB de verdade" -f ($fisico / 1MB))
  }
  Escrever-Marcador $fs 0
  Escrever-Marcador $fs $Apos2GiB
  Escrever-Marcador $fs ($Tamanho - 4096)
  $fs.Flush()
  $fs.Dispose()
  $fs = $null
  $fisico = [Bt3ProbeSparse]::PhysicalSize($Caminho)
  if ($fisico -gt $LimiteFisico) {
    throw ("depois dos marcadores o arquivo ocupa {0:N0} MiB de verdade" -f ($fisico / 1MB))
  }
} catch {
  $motivo = $_.Exception.Message
  if ($fs) { $fs.Dispose() }
  if (Test-Path -LiteralPath $Caminho) { Remove-Item -LiteralPath $Caminho -Force -ErrorAction SilentlyContinue }
  # Só afirma que apagou depois de conferir.
  if (Test-Path -LiteralPath $Caminho) {
    Write-Host "ERRO: $motivo." -ForegroundColor Red
    Write-Host "ATENÇÃO: NÃO consegui apagar o arquivo incompleto: $Caminho" -ForegroundColor Yellow
    Write-Host "Apague manualmente: feche programas que possam estar usando o arquivo e rode" -ForegroundColor Yellow
    Write-Host "  Remove-Item -LiteralPath `"$Caminho`" -Force" -ForegroundColor Yellow
    Write-Host "ou apague pelo Explorador de Arquivos (e esvazie a Lixeira)." -ForegroundColor Yellow
    exit 2
  }
  Write-Host "ERRO: $motivo. O arquivo incompleto foi apagado (conferido); nada ficou ocupando espaço." -ForegroundColor Red
  exit 1
}

Write-Host "Arquivo de teste criado: $Caminho" -ForegroundColor Green
Write-Host ("  Tamanho lógico (o que o navegador vê): {0:N0} bytes (3 GiB)" -f $Tamanho)
Write-Host ("  Espaço realmente ocupado no disco:     {0:N0} KiB" -f [math]::Ceiling($fisico / 1KB))
Write-Host "  Marcadores: início, depois de 2 GiB e fim."
Write-Host ""
Write-Host "Para apagar depois do teste:"
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Apagar"
Write-Host "Atenção: copiar este arquivo para outro lugar (ex.: celular) ocupa 3 GiB de verdade."
