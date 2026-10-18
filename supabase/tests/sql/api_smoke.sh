#!/usr/bin/env bash
# HTTP-level smoke test of the database contract through the real local gateway (GoTrue, PostgREST, Storage):
#   anonymous sign-in → profile created by the auth trigger (as supabase_auth_admin), my_status, column-limited
#   analyses select, get_result 404, private schema closed to clients, storage upsert in the own folder
#   (INSERT + SELECT + UPDATE), refusals for another folder / analysis-derived / uppercase ids, service-role writes
#   to analysis-derived readable by the owner only.
# Users and objects it creates are removed at the end.
set -euo pipefail
# shellcheck source=supabase/tests/sql/_lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

API_URL="${API_URL:-$(sb_env API_URL)}"
ANON_KEY="${ANON_KEY:-$(sb_env PUBLISHABLE_KEY)}"
SERVICE_KEY="${SERVICE_KEY:-$(sb_env SECRET_KEY)}"
[[ -n "$API_URL" && -n "$ANON_KEY" && -n "$SERVICE_KEY" ]] || { echo "api_smoke.sh: stack not running"; exit 1; }

WORK="$(mktemp -d)"
USERS=()
AID=""
cleanup() {
  local uid
  for uid in ${USERS[@]+"${USERS[@]}"}; do # empty-array safe under set -u on bash 3.2 (macOS)
    for bucket in analysis-inputs analysis-derived; do
      curl -s -o /dev/null -X DELETE "$API_URL/storage/v1/object/$bucket" -H "apikey: $SERVICE_KEY" \
        -H "Authorization: Bearer $SERVICE_KEY" -H 'Content-Type: application/json' \
        -d "{\"prefixes\": [\"$uid/$AID/frames/F1.jpg\", \"$uid/$AID/pose.clean.json\"]}" || true
    done
    curl -s -o /dev/null -X DELETE "$API_URL/auth/v1/admin/users/$uid" -H "apikey: $SERVICE_KEY" \
      -H "Authorization: Bearer $SERVICE_KEY" || true
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

json() { python3 -I -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {'d': d}))" "$1"; }

# status <method> <url> <token> [curl args…] → HTTP status; body in $WORK/body
status() {
  local method="$1" url="$2" token="$3"
  shift 3
  curl -s -o "$WORK/body" -w '%{http_code}' -X "$method" "$url" -H "apikey: $ANON_KEY" \
    -H "Authorization: Bearer $token" "$@"
}

anon_signin() {
  curl -s -X POST "$API_URL/auth/v1/signup" -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' -d '{}'
}

echo "api_smoke.sh: $API_URL"
S1="$(anon_signin)"
T1="$(echo "$S1" | json "d['access_token']")"
U1="$(echo "$S1" | json "d['user']['id']")"
S2="$(anon_signin)"
T2="$(echo "$S2" | json "d['access_token']")"
U2="$(echo "$S2" | json "d['user']['id']")"
USERS=("$U1" "$U2")
AID="$(python3 -I -c 'import uuid; print(uuid.uuid4())')"
expect_eq "anonymous sign-in returns lowercase ids" "$U1" "$(echo "$U1" | tr 'A-F' 'a-f')"

expect_eq "profile row created by the auth trigger (GoTrue path)" "200 $U1" \
  "$(status GET "$API_URL/rest/v1/profiles?select=id" "$T1") $(json "d[0]['id']" <"$WORK/body")"
expect_eq "my_status: anonymous free user with the first-ever bonus" "200 free True True" \
  "$(status POST "$API_URL/rest/v1/rpc/my_status" "$T1" -H 'Content-Type: application/json' -d '{}') \
$(json "d['tier'], d['bonusAvailable'], d['isAnonymous']" <"$WORK/body" | tr -d "(),'")"
expect_eq "analyses: granted columns readable" "200" "$(status GET "$API_URL/rest/v1/analyses?select=id,status" "$T1")"
expect_eq "analyses: prepared column refused" "403" \
  "$(status GET "$API_URL/rest/v1/analyses?select=id,prepared" "$T1")"
expect_eq "get_result of an unknown id → 404 analysis_not_found" "404 analysis_not_found" \
  "$(status POST "$API_URL/rest/v1/rpc/get_result" "$T1" -H 'Content-Type: application/json' \
    -d "{\"p_analysis_id\": \"$AID\"}") $(json "d['message']" <"$WORK/body")"
expect_eq "private schema closed to clients" "403" \
  "$(status GET "$API_URL/rest/v1/llm_calls" "$T1" -H 'Accept-Profile: private')"
expect_eq "private schema open to the service role" "200" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/rest/v1/daily_spend" -H "apikey: $SERVICE_KEY" \
    -H 'Accept-Profile: private')"

# Storage ---------------------------------------------------------------------------------------------------------------
printf '\xff\xd8\xff\xe0fake-jpeg\xff\xd9' >"$WORK/f.jpg"
up() { # up <token> <bucket> <path> <content-type> [upsert]
  status POST "$API_URL/storage/v1/object/$2/$3" "$1" -H "Content-Type: $4" -H "x-upsert: ${5:-false}" \
    --data-binary "@$WORK/f.jpg"
}
expect_eq "upload a key frame into the own folder" "200" "$(up "$T1" analysis-inputs "$U1/$AID/frames/F1.jpg" image/jpeg)"
expect_eq "upsert the same key frame (needs SELECT + UPDATE)" "200" \
  "$(up "$T1" analysis-inputs "$U1/$AID/frames/F1.jpg" image/jpeg true)"
code="$(up "$T1" analysis-inputs "$U1/$AID/frames/F1.jpg" image/jpeg false)"
expect_eq "upload without upsert onto an existing frame is refused" "refused" \
  "$([[ $code =~ ^(400|409)$ ]] && echo refused || echo "$code")"
code="$(up "$T1" analysis-inputs "$U2/$AID/frames/F1.jpg" image/jpeg true)"
expect_eq "upload into another user's folder is refused" "refused" \
  "$([[ $code =~ ^(400|403)$ ]] && echo refused || echo "$code")"
code="$(up "$T1" analysis-inputs "$U1/$(echo "$AID" | tr 'a-f' 'A-F')/frames/F1.jpg" image/jpeg)"
expect_eq "upload with an uppercase analysis id is refused" "refused" \
  "$([[ $code =~ ^(400|403)$ ]] && echo refused || echo "$code")"
code="$(up "$T1" analysis-derived "$U1/$AID/pose.clean.json" application/json)"
expect_eq "clients cannot write analysis-derived" "refused" \
  "$([[ $code =~ ^(400|403)$ ]] && echo refused || echo "$code")"
code="$(up "$T1" analysis-inputs "$U1/$AID/frames/F2.jpg" image/png)"
expect_eq "non-JPEG uploads are refused by the bucket" "refused" \
  "$([[ $code =~ ^(400|415|422)$ ]] && echo refused || echo "$code")"

echo '{"schema":"clean-track.v1"}' >"$WORK/clean.json"
expect_eq "service role writes pose JSON to analysis-derived" "200" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API_URL/storage/v1/object/analysis-derived/$U1/$AID/pose.clean.json" \
    -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" -H 'Content-Type: application/json' \
    --data-binary "@$WORK/clean.json")"
expect_eq "owner downloads the pose JSON" "200" \
  "$(status GET "$API_URL/storage/v1/object/authenticated/analysis-derived/$U1/$AID/pose.clean.json" "$T1")"
code="$(status GET "$API_URL/storage/v1/object/authenticated/analysis-derived/$U1/$AID/pose.clean.json" "$T2")"
expect_eq "another user cannot download it" "refused" \
  "$([[ $code =~ ^(400|403|404)$ ]] && echo refused || echo "$code")"
expect_eq "owner deletes own key frame" "200" \
  "$(status DELETE "$API_URL/storage/v1/object/analysis-inputs" "$T1" -H 'Content-Type: application/json' \
    -d "{\"prefixes\": [\"$U1/$AID/frames/F1.jpg\"]}")"

if [[ $FAILURES -ne 0 ]]; then
  echo "api_smoke.sh: $FAILURES failure(s)"
  exit 1
fi
echo "api_smoke.sh: OK"
