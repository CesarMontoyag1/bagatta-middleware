# sync_all_products.ps1
#
# Recorre TODO el catalogo de Shopify (paginado) y llama al endpoint de
# ingesta manual del middleware para cada producto. Util cuando cambias de
# base de datos o de cuenta de Alegra y necesitas re-sincronizar todo desde
# cero.
#
# Requiere:
# - Haber corrido .\login.ps1 antes (usa el token guardado en ~/.bagatta_token.json)
# - Tu SHOPIFY_ACCESS_TOKEN (empieza con shpua_)

param(
    #[string]$BaseUrl      = "https://bagatta-middleware.onrender.com",
    [string]$BaseUrl      = "http://localhost:3000",
    [string]$ShopDomain   = "bagatta-middleware.myshopify.com",
    [string]$ShopifyToken = $env:SHOPIFY_ACCESS_TOKEN,
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

$shopifyHeaders = @{ "X-Shopify-Access-Token" = $ShopifyToken }

$foundCount    = 0
$ingestedCount = 0
$errorCount    = 0

# -- 1. Recorrer TODOS los productos de Shopify (paginacion por cursor) ------
$nextUrl = "https://$ShopDomain/admin/api/2024-04/products.json?limit=250&fields=id,title,handle"
$allProductIds = @()

Write-Host "Descargando lista completa de productos desde Shopify..." -ForegroundColor Cyan

while ($nextUrl) {
    $response = Invoke-WebRequest -Uri $nextUrl -Headers $shopifyHeaders -Method Get
    $json = $response.Content | ConvertFrom-Json

    foreach ($product in $json.products) {
        $allProductIds += $product.id
    }

    # Shopify usa paginacion por cursor: la siguiente pagina viene en el header Link
    $linkHeader = $response.Headers["Link"]
    $nextUrl = $null

    if ($linkHeader) {
        $links = $linkHeader -split ","
        foreach ($link in $links) {
            if ($link -match '<([^>]+)>;\s*rel="next"') {
                $nextUrl = $matches[1]
            }
        }
    }

    Start-Sleep -Seconds $DelaySeconds
}

Write-Host "Total de productos encontrados en Shopify: $($allProductIds.Count)" -ForegroundColor Cyan
Write-Host ""

# -- 2. Llamar al endpoint de ingesta para cada producto ---------------------
foreach ($productId in $allProductIds) {
    $foundCount++
    $ingested = $false
    $attempt = 0

    while ((-not $ingested) -and ($attempt -le $Max429Retries)) {
        try {
            $null = Invoke-RestMethod -Uri "$BaseUrl/api/v1/sync/ingest-product/$productId" `
                -Method Post -Headers @{ Authorization = "Bearer $MiddlewareToken" }
            Write-Host "[$productId] ingerido OK ($foundCount / $($allProductIds.Count))" -ForegroundColor Green
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
                Write-Host "[$productId] 429 - reintentando en $waitTime seg (intento $($attempt + 1) de $Max429Retries)" -ForegroundColor Yellow
                Start-Sleep -Seconds $waitTime
                $attempt = $attempt + 1
            }
            else {
                Write-Host "[$productId] ERROR: $($_.Exception.Message)" -ForegroundColor Red
                $errorCount++
                break
            }
        }
    }

    Start-Sleep -Seconds $DelaySeconds
}

Write-Host ""
Write-Host "===== RESUMEN =====" -ForegroundColor Cyan
Write-Host "Productos encontrados en Shopify: $foundCount"
Write-Host "Ingeridos OK:                     $ingestedCount"
Write-Host "Errores:                          $errorCount"