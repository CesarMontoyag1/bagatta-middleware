# login.ps1 — Inicia sesion en el middleware de Bagatta y guarda el token localmente.
#
# Uso:
#   .\login.ps1
#   .\login.ps1 -BaseUrl "http://localhost:3000"
#
# Si la primera vez PowerShell bloquea la ejecucion del script, corre esto
# una sola vez (como administrador o en tu sesion actual):
#   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

param(
    [string]$BaseUrl = "http://localhost:3000"
)

$TokenFile = Join-Path $env:USERPROFILE ".bagatta_token.json"

$Email = Read-Host "Email"
$SecurePassword = Read-Host "Password" -AsSecureString
$Password = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePassword)
)

Write-Host "Iniciando sesion en $BaseUrl ..."

$Body = @{
    email    = $Email
    password = $Password
} | ConvertTo-Json

# Forzar UTF-8 explícito en el cuerpo de la petición. Sin esto, Windows
# PowerShell 5.1 puede corromper caracteres como ñ, á, é, ¡, etc. al enviar
# el body, causando que la contraseña recibida en el servidor no coincida
# con la que realmente escribiste (aunque en pantalla se vea igual).
$BodyBytes = [System.Text.Encoding]::UTF8.GetBytes($Body)

try {
    $Response = Invoke-RestMethod -Uri "$BaseUrl/api/v1/auth/login" `
        -Method Post `
        -ContentType "application/json; charset=utf-8" `
        -Body $BodyBytes
}
catch {
    Write-Host "Login fallo:" -ForegroundColor Red
    if ($_.ErrorDetails.Message) {
        Write-Host $_.ErrorDetails.Message
    } else {
        Write-Host $_.Exception.Message
    }
    exit 1
}

# Guardar el token localmente
$Response | ConvertTo-Json | Set-Content -Path $TokenFile -Encoding UTF8

Write-Host "Login exitoso como rol: $($Response.role)" -ForegroundColor Green
Write-Host "   Token guardado en: $TokenFile"
Write-Host ""
Write-Host "Ahora puedes usar request.ps1 para hacer peticiones, por ejemplo:"
Write-Host "   .\request.ps1 -Method GET -Path /api/v1/inventory"