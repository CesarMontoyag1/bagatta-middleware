# recover_stress_test.ps1
#
# Recupera los 500 productos de prueba (handles stress-test-0001 .. 0500):
# 1. Resuelve el shopifyProductId consultando Shopify directamente por handle.
# 2. Llama al endpoint /api/v1/sync/ingest-product/:id para forzar la
#    creacion en Alegra (es seguro llamarlo aunque el producto ya exista).
#
# Requiere:
# - Haber corrido .\login.ps1 antes (usa el token guardado en ~/.bagatta_token.json)
# - Tu SHOPIFY_ACCESS_TOKEN (empieza con shpua_)

param(
    [string]$BaseUrl      = "https://bagatta-middleware.onrender.com",
    [string]$ShopDomain   = "bagatta-middleware.myshopify.com",
    [string]$ShopifyToken = $env:SHOPIFY_ACCESS_TOKEN,
    [int]$StartIndex      = 1,
    [int]$EndIndex        = 500,
    [double]$DelaySeconds = 1.0,
    [int]$Max429Retries   = 5
)

if (-not $ShopifyToken) {
    $ShopifyToken = Read-Host "Ingresa tu SHOPIFY_ACCESS_TOKEN (shpua_...)"
}

$TokenFile = Join-Path $env:USERPROFILE ".bagatta_token.json"
if (-not (Test-Path $TokenFile)) {
    Write-Host "No hay sesion guardada. Corre primero: .\login.ps1" -ForegroundColor Red
    exit 1
}
$MiddlewareToken = (Get-Content $TokenFile -Raw | ConvertFrom-Json).access_token

$foundCount    = 0
$notFoundCount = 0
$ingestedCount = 0
$errorCount    = 0

for ($i = $StartIndex; $i -le $EndIndex; $i++) {
    $handle = "stress-test-{0:D4}" -f $i

    try {
        $shopifyResponse = Invoke-RestMethod -Uri "https://$ShopDomain/admin/api/2024-04/products.json?handle=$handle" -Headers @{ "X-Shopify-Access-Token" = $ShopifyToken }

        Start-Sleep -Seconds $DelaySeconds

        if ($shopifyResponse.products.Count -eq 0) {
            Write-Host "[$handle] no encontrado en Shopify" -ForegroundColor Yellow
            $notFoundCount++
            continue
        }

        $productId = $shopifyResponse.products[0].id
        $foundCount++

        $ingested = $false
        $attempt = 0

        while ((-not $ingested) -and ($attempt -le $Max429Retries)) {
            try {
                $null = Invoke-RestMethod -Uri "$BaseUrl/api/v1/sync/ingest-product/$productId" -Method Post -Headers @{ Authorization = "Bearer $MiddlewareToken" }
                Write-Host "[$handle] id=$productId -> ingerido OK" -ForegroundColor Green
                $ingestedCount++
                $ingested = $true
            }
            catch {
                $statusCode = 0
                if ($_.Exception.Response) {
                    $statusCode = [int]$_.Exception.Response.StatusCode
                }

                if (($statusCode -eq 429) -and ($attempt -lt $Max429Retries)) {
                    $waitTime = [Math]::Pow(2, $attempt) * 2
                    Write-Host "[$handle] 429 - reintentando en $waitTime seg (intento $($attempt + 1) de $Max429Retries)" -ForegroundColor Yellow
                    Start-Sleep -Seconds $waitTime
                    $attempt = $attempt + 1
                }
                else {
                    throw
                }
            }
        }
    }
    catch {
        Write-Host "[$handle] ERROR: $($_.Exception.Message)" -ForegroundColor Red
        $errorCount++
    }

    Start-Sleep -Seconds $DelaySeconds
}

Write-Host ""
Write-Host "===== RESUMEN =====" -ForegroundColor Cyan
Write-Host "Encontrados en Shopify: $foundCount"
Write-Host "No encontrados:         $notFoundCount"
Write-Host "Ingeridos OK:           $ingestedCount"
Write-Host "Errores:                $errorCount"