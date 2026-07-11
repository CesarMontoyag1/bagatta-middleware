# recover_stress_test.ps1
#
# Recupera los 500 productos de prueba (handles stress-test-0001 .. 0500):
# 1. Resuelve el shopifyProductId consultando Shopify directamente por handle.
# 2. Llama a tu endpoint /api/v1/sync/ingest-product/:id para forzar la
#    creación en Alegra (es seguro llamarlo aunque el producto ya exista).
#
# Requiere:
# - Haber corrido .\login.ps1 antes (usa el token guardado en ~/.bagatta_token.json)
# - Tu SHOPIFY_ACCESS_TOKEN y SHOPIFY_SHOP_DOMAIN (los mismos de tu .env)

param(
    [string]$BaseUrl          = "https://bagatta-middleware.onrender.com",
    [string]$ShopDomain       = "bagatta-middleware.myshopify.com",
    [string]$ShopifyToken     = $env:SHOPIFY_ACCESS_TOKEN,
    [int]$StartIndex          = 1,
    [int]$EndIndex            = 500,
    [double]$DelaySeconds     = 1.0,  # más margen: el middleware también consume del mismo límite de Shopify por su cuenta
    [int]$Max429Retries       = 5
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

$results = @{ found = 0; not_found = 0; ingested = 0; errors = 0 }

for ($i = $StartIndex; $i -le $EndIndex; $i++) {
    $handle = "stress-test-{0:D4}" -f $i

    try {
        # ── 1. Resolver shopifyProductId por handle ──────────────────────────
        $shopifyResponse = Invoke-RestMethod -Uri "https://$ShopDomain/admin/api/2024-04/products.json?handle=$handle" `
            -Headers @{ "X-Shopify-Access-Token" = $ShopifyToken }

        Start-Sleep -Seconds $DelaySeconds

        if ($shopifyResponse.products.Count -eq 0) {
            Write-Host "[$handle] no encontrado en Shopify (¿se borró?)" -ForegroundColor Yellow
            $results.not_found++
            continue
        }

        $productId = $shopifyResponse.products[0].id
        $results.found++

        # ── 2. Forzar ingesta en tu middleware (con reintento ante 429) ──────
        $ingested = $false
        $attempt = 0
        while (-not $ingested -and $attempt -le $Max429Retries) {
            try {
                $ingestResponse = Invoke-RestMethod -Uri "$BaseUrl/api/v1/sync/ingest-product/$productId" `
                    -Method Post `
                    -Headers @{ Authorization = "Bearer $MiddlewareToken" }
                Write-Host "[$handle] id=$productId -> ingerido OK" -ForegroundColor Green
                $results.ingested++
                $ingested = $true
            }
            catch {
                $statusCode = $_.Exception.Response.StatusCode.value__
                if ($statusCode -eq 429 -and $attempt -lt $Max429Retries) {
                    $waitTime = [Math]::Pow(2, $attempt) * 2  # backoff exponencial: 2s, 4s, 8s, 16s...
                    Write-Host "[$handle] 429 — reintentando en ${waitTime}s (intento $($attempt+1)/$Max429Retries)" -ForegroundColor Yellow
                    Start-Sleep -Seconds $waitTime
                    $attempt++
                } else {
                    throw
                }
            }
        }
    }
    catch {
        Write-Host "[$handle] ERROR: $($_.Exception.Message)" -ForegroundColor Red
        $results.errors++
    }

    Start-Sleep -Seconds $DelaySeconds
}

Write-Host ""
Write-Host "===== RESUMEN =====" -ForegroundColor Cyan
Write-Host "Encontrados en Shopify: $($results.found)"
Write-Host "No encontrados:         $($results.not_found)"
Write-Host "Ingeridos OK:           $($results.ingested)"
Write-Host "Errores:                $($results.errors)"