#!/usr/bin/env bash
# login.sh — Inicia sesión en el middleware de Bagatta y guarda el token localmente.
#
# Requiere: curl, jq  (en Mac: brew install jq | en Ubuntu/WSL: sudo apt install jq)
#
# Uso:
#   ./login.sh
#   (te pide email y password, o los puedes pasar como variables de entorno)
#
#   BASE_URL=https://tu-dominio.onrender.com EMAIL=tu@email.com PASSWORD=tu_pass ./login.sh
#
# Después de correr esto una vez, usa request.sh para hacer cualquier
# petición autenticada sin volver a escribir el token a mano.

set -euo pipefail

# ── Configuración ────────────────────────────────────────────────────────────
BASE_URL="${BASE_URL:-http://localhost:3000}"
TOKEN_FILE="$HOME/.bagatta_token.json"

# ── Pedir credenciales si no vienen por variable de entorno ─────────────────
if [ -z "${EMAIL:-}" ]; then
  read -rp "Email: " EMAIL
fi

if [ -z "${PASSWORD:-}" ]; then
  read -rsp "Password: " PASSWORD
  echo
fi

# ── Login ─────────────────────────────────────────────────────────────────────
echo "Iniciando sesión en $BASE_URL ..."

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" != "200" ]; then
  echo "❌ Login falló (HTTP $HTTP_CODE)"
  echo "$BODY"
  exit 1
fi

# ── Guardar el token localmente ──────────────────────────────────────────────
echo "$BODY" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"   # solo tú puedes leer este archivo

ACCESS_TOKEN=$(echo "$BODY" | jq -r '.access_token')
ROLE=$(echo "$BODY" | jq -r '.role')

echo "✅ Login exitoso como rol: $ROLE"
echo "   Token guardado en: $TOKEN_FILE"
echo
echo "Ahora puedes usar request.sh para hacer peticiones, por ejemplo:"
echo "   ./request.sh GET /api/v1/inventory"