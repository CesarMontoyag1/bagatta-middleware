# request.ps1 — Hace una peticion autenticada usando el token guardado por login.ps1.
# Si el access token ya expiro, lo renueva automaticamente con el refresh token.
#
# Uso:
#   .\request.ps1 -Method GET -Path /api/v1/inventory
#   .\request.ps1 -Method POST -Path /api/v1/sync/force/global
#   .\request.ps1 -Method POST -Path /api/v1/sync/force/SKU-123
#
# Requiere haber corrido .\login.ps1 al menos una vez antes.

param(
    [Parameter(Mandatory=$true)]
    [string]$Method,

    [Parameter(Mandatory=$true)]
    [string]$Path,

    [string]$BaseUrl = "http://localhost:3000"
)

$TokenFile = Join-Path $env:USERPROFILE ".bagatta_token.json"

if (-not (Test-Path $TokenFile)) {
    Write-Host "No hay sesion guardada. Corre primero: .\login.ps1" -ForegroundColor Red
    exit 1
}

$TokenData = Get-Content $TokenFile -Raw | ConvertFrom-Json
$AccessToken = $TokenData.access_token
$RefreshToken = $TokenData.refresh_token

function Invoke-Authed {
    param([string]$Token)
    try {
        $response = Invoke-RestMethod -Uri "$BaseUrl$Path" `
            -Method $Method `
            -Headers @{ Authorization = "Bearer $Token" } `
            -ContentType "application/json"
        return @{ Body = $response; StatusCode = 200 }
    }
    catch {
        $code = $null
        if ($_.Exception.Response) {
            $code = [int]$_.Exception.Response.StatusCode
        }
        return @{ Body = $null; StatusCode = $code; Error = $_ }
    }
}

$Result = Invoke-Authed -Token $AccessToken
$StatusCode = $Result.StatusCode

# Si el token expiro (401), intentar renovarlo automaticamente
if ($StatusCode -eq 401) {
    Write-Host "Token expirado, renovando..." -ForegroundColor Yellow

    $RefreshBody = @{ refresh_token = $RefreshToken } | ConvertTo-Json
    $RefreshBodyBytes = [System.Text.Encoding]::UTF8.GetBytes($RefreshBody)

    try {
        $RefreshResponse = Invoke-RestMethod -Uri "$BaseUrl/api/v1/auth/refresh" `
            -Method Post `
            -ContentType "application/json; charset=utf-8" `
            -Body $RefreshBodyBytes
    }
    catch {
        Write-Host "No se pudo renovar el token. Corre .\login.ps1 de nuevo." -ForegroundColor Red
        exit 1
    }

    # Guardar el nuevo access_token y refresh_token (rotado)
    $NewTokenData = [PSCustomObject]@{
        access_token  = $RefreshResponse.access_token
        refresh_token = $RefreshResponse.refresh_token
        role          = $TokenData.role
    }
    $NewTokenData | ConvertTo-Json | Set-Content -Path $TokenFile -Encoding UTF8

    $RetryResult = Invoke-Authed -Token $RefreshResponse.access_token
    $Result = $RetryResult
    $StatusCode = $RetryResult.StatusCode
}

if ($Result.Body) {
    $Result.Body | ConvertTo-Json -Depth 10
} else {
    Write-Host "Error en la peticion (HTTP $StatusCode):" -ForegroundColor Red
    if ($Result.Error.ErrorDetails.Message) {
        Write-Host $Result.Error.ErrorDetails.Message
    }
}

if ($StatusCode -ge 400) {
    exit 1
}