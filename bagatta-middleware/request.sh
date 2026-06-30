#!/usr/bin/env bash
# request.sh — Hace una petición autenticada usando el token guardado por login.sh.
# Si el access token ya expiró, lo renueva automáticamente con el refresh token.
#
# Uso:
#   ./request.sh GET /api/v1/inventory
#   ./request.sh POST /api/v1/sync/force/global
#   ./request.sh POST /api/v1/sync/force/SKU-123
#
# Requiere haber corrido ./login.sh al menos una vez antes.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
TOKEN_FILE="$HOME/.bagatta_token.json"

if [ ! -f "$TOKEN_FILE" ]; then
  echo "❌ No hay sesión guardada. Corre primero: ./login.sh"
  exit 1
fi

METHOD="${1:-GET}"
PATH_PART="${2:-/}"

ACCESS_TOKEN=$(jq -r '.access_token' "$TOKEN_FILE")
REFRESH_TOKEN=$(jq -r '.refresh_token' "$TOKEN_FILE")

# ── Función para hacer la petición ───────────────────────────────────────────
do_request() {
  curl -s -w "\n%{http_code}" -X "$METHOD" "$BASE_URL$PATH_PART" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Content-Type: application/json"
}

RESPONSE=$(do_request)
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

# ── Si el token expiró (401), intentar renovarlo automáticamente ────────────
if [ "$HTTP_CODE" == "401" ]; then
  echo "Token expirado, renovando..." >&2

  REFRESH_RESPONSE=$(curl -s -X POST "$BASE_URL/api/v1/auth/refresh" \
    -H "Content-Type: application/json" \
    -d "{\"refresh_token\":\"$REFRESH_TOKEN\"}")

  NEW_ACCESS=$(echo "$REFRESH_RESPONSE" | jq -r '.access_token // empty')

  if [ -z "$NEW_ACCESS" ]; then
    echo "❌ No se pudo renovar el token. Corre ./login.sh de nuevo." >&2
    exit 1
  fi

  # Guardar el nuevo access_token y refresh_token (rotado) en el archivo
  jq -n --arg at "$NEW_ACCESS" \
        --arg rt "$(echo "$REFRESH_RESPONSE" | jq -r '.refresh_token')" \
        --arg role "$(jq -r '.role' "$TOKEN_FILE")" \
        '{access_token: $at, refresh_token: $rt, role: $role}' > "$TOKEN_FILE"

  ACCESS_TOKEN="$NEW_ACCESS"
  RESPONSE=$(do_request)
  HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
  BODY=$(echo "$RESPONSE" | sed '$d')
fi

echo "$BODY" | jq . 2>/dev/null || echo "$BODY"

if [ "$HTTP_CODE" -ge 400 ]; then
  exit 1
fi