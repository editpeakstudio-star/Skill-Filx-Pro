#!/usr/bin/env bash
set -euo pipefail

REPO="editpeakstudio-star/Skill-Filx-Pro"
BRANCH="main"
PROJECT_ID="skillflix-academy"
HOSTING_URL="https://skillflix-academy.web.app"
WORKFLOW_FILE="deploy-telegram-worker.yml"
WORKER_NAME="skill-flix-telegram-api"

# Track step status for final report
STEP_TOOLS="PENDING"
STEP_AUTH="PENDING"
STEP_PROJECT_CHECK="PENDING"
STEP_IAM_APIS="PENDING"
STEP_SECRETS="PENDING"
STEP_WORKER_DEPLOY="PENDING"
STEP_ENV_URL="PENDING"
STEP_HOSTING_DEPLOY="PENDING"
STEP_RULES_DEPLOY="PENDING"
STEP_VERIFICATION="PENDING"
DEPLOYED_WORKER_URL=""

red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[1;33m%s\033[0m\n' "$*"; }
cyan()   { printf '\033[0;36m%s\033[0m\n' "$*"; }

cleanup_temp() {
  rm -f /tmp/sf-sa-check.json /tmp/sf-cf-check.json /tmp/sf-unauth.json /tmp/sf-unauth.hdr /tmp/sf-index.html 2>/dev/null || true
}
trap cleanup_temp EXIT

on_error() {
  local line="$1"
  echo ""
  red "=================================================="
  red " DEPLOYMENT FAILED AT LINE $line"
  red "=================================================="
  echo "Tools Check:        $STEP_TOOLS"
  echo "Authentication:     $STEP_AUTH"
  echo "Project & Account:  $STEP_PROJECT_CHECK"
  echo "IAM & APIs:         $STEP_IAM_APIS"
  echo "Secrets Check:      $STEP_SECRETS"
  echo "Worker Deploy:      $STEP_WORKER_DEPLOY"
  echo "VITE_TELEGRAM_URL:  $STEP_ENV_URL"
  echo "Hosting Deploy:     $STEP_HOSTING_DEPLOY"
  echo "Firestore Rules:    $STEP_RULES_DEPLOY"
  echo "Live Verification:  $STEP_VERIFICATION"
  echo "Safe recovery: Fix the error reported above and re-run: bash deploy-all.sh"
}
trap 'on_error $LINENO' ERR

echo "=================================================="
cyan " Skill-Flix-Pro Full Automated Deployment (Termux)"
echo " Repository:       $REPO ($BRANCH)"
echo " Firebase Project: $PROJECT_ID"
echo "=================================================="

if [ ! -f "package.json" ] || [ ! -f "firebase.json" ] || [ ! -f "firestore.rules" ]; then
  red "ERROR: Run this script from inside ~/Skill-Filx-Pro (missing package.json, firebase.json, or firestore.rules)."
  exit 1
fi

IS_TERMUX=0
if [ -n "${TERMUX_VERSION:-}" ] || [ "$(uname -o 2>/dev/null || true)" = "Android" ]; then
  IS_TERMUX=1
fi

# --------------------------------------------------
# 1. Check and install required CLI tools
# --------------------------------------------------
echo ""
cyan "[1/10] Checking required CLI tools..."
MISSING_PKGS=()
command -v git  >/dev/null 2>&1 || MISSING_PKGS+=("git")
command -v node >/dev/null 2>&1 || MISSING_PKGS+=("nodejs-lts")
command -v curl >/dev/null 2>&1 || MISSING_PKGS+=("curl")
command -v gh   >/dev/null 2>&1 || MISSING_PKGS+=("gh")

if [ "${#MISSING_PKGS[@]}" -gt 0 ]; then
  if [ "$IS_TERMUX" -eq 1 ] && command -v pkg >/dev/null 2>&1; then
    yellow "Installing missing Termux packages: ${MISSING_PKGS[*]}"
    pkg update -y
    pkg install -y "${MISSING_PKGS[@]}"
  else
    red "ERROR: Missing required tools: ${MISSING_PKGS[*]}. Install them and retry."
    exit 1
  fi
fi

if ! command -v firebase >/dev/null 2>&1; then
  yellow "Installing firebase-tools globally..."
  npm install -g firebase-tools@13.35.1 --no-audit --no-fund
fi

if [ "$IS_TERMUX" -eq 1 ]; then
  echo "Android Termux detected: local Wrangler/workerd is skipped (handled on GitHub Actions Ubuntu runner)."
fi
STEP_TOOLS="SUCCESS"
green "All required CLI tools ready."

# --------------------------------------------------
# 2. Authenticate GitHub, Firebase, and Cloudflare
# --------------------------------------------------
echo ""
cyan "[2/10] Authenticating GitHub, Firebase, and Cloudflare..."

if ! gh auth status >/dev/null 2>&1; then
  yellow "GitHub login required. Opening official browser/device flow..."
  gh auth login --web --git-protocol https
fi
gh auth setup-git >/dev/null 2>&1 || true
green "GitHub authenticated."

if ! firebase projects:list --json >/dev/null 2>&1; then
  yellow "Firebase login required. Starting official Firebase CLI OAuth..."
  if [ "$IS_TERMUX" -eq 1 ]; then
    firebase login --no-localhost
  else
    firebase login
  fi
fi
green "Firebase CLI authenticated."

# Cloudflare credentials stay strictly in memory/GitHub Secrets (never echoed)
CF_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
CF_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
EXISTING_SECRETS=$(gh secret list --repo "$REPO" --json name --jq '.[].name' || true)

has_gh_secret() {
  echo "$EXISTING_SECRETS" | grep -qx "$1"
}

if ! has_gh_secret "CLOUDFLARE_ACCOUNT_ID" && [ -z "$CF_ACCOUNT_ID" ]; then
  echo ""
  echo "Cloudflare Account ID is needed (32-hex ID from https://dash.cloudflare.com -> Workers & Pages)."
  read -r -p "Enter Cloudflare Account ID: " CF_ACCOUNT_ID
  CF_ACCOUNT_ID=$(printf '%s' "$CF_ACCOUNT_ID" | tr -d '[:space:]')
fi

if ! has_gh_secret "CLOUDFLARE_API_TOKEN" && [ -z "$CF_API_TOKEN" ]; then
  echo ""
  echo "Create a Cloudflare API Token using the 'Edit Cloudflare Workers' template at:"
  echo "  https://dash.cloudflare.com/profile/api-tokens"
  read -r -s -p "Enter Cloudflare API Token (hidden input): " CF_API_TOKEN
  echo ""
  CF_API_TOKEN=$(printf '%s' "$CF_API_TOKEN" | tr -d '[:space:]')
fi

STEP_AUTH="SUCCESS"

# --------------------------------------------------
# 3. Check existing Firebase project & Cloudflare account
# --------------------------------------------------
echo ""
cyan "[3/10] Verifying Firebase project ($PROJECT_ID) and Cloudflare account..."

FB_PROJECT_OK=$(firebase projects:list --json | node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf8") || "{}");
  const list = Array.isArray(data.result) ? data.result : [];
  process.stdout.write(list.some(p => p.projectId === process.argv[1]) ? "1" : "0");
' "$PROJECT_ID" || echo "0")

if [ "$FB_PROJECT_OK" != "1" ]; then
  red "ERROR: Authenticated Google account cannot access Firebase project '$PROJECT_ID'."
  exit 1
fi
firebase use "$PROJECT_ID" >/dev/null
green "Firebase project '$PROJECT_ID' verified."

if [ -n "$CF_ACCOUNT_ID" ] && [ -n "$CF_API_TOKEN" ]; then
  if ! printf '%s' "$CF_ACCOUNT_ID" | grep -Eq '^[a-fA-F0-9]{32}$'; then
    red "ERROR: CLOUDFLARE_ACCOUNT_ID must be a 32-character hex string."
    exit 1
  fi
  CF_AUTH_HEADER=()
  if [[ "$CF_API_TOKEN" == cfk_* ]]; then
    CF_AUTH_HEADER=(-H "X-Auth-Email: editpeakstudio@gmail.com" -H "X-Auth-Key: ${CF_API_TOKEN}")
  else
    CF_AUTH_HEADER=(-H "Authorization: Bearer ${CF_API_TOKEN}")
  fi

  CF_STATUS=$(curl -sS -o /tmp/sf-cf-check.json -w "%{http_code}" \
    "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts" \
    "${CF_AUTH_HEADER[@]}" || echo "000")
  if [ "$CF_STATUS" != "200" ]; then
    red "ERROR: Cloudflare API rejected credentials (HTTP $CF_STATUS). Check credentials and Account ID."
    exit 1
  fi
  CF_SUBDOMAIN=$(curl -sS "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/subdomain" \
    "${CF_AUTH_HEADER[@]}" | node -e '
      const d = JSON.parse(require("fs").readFileSync(0, "utf8") || "{}");
      process.stdout.write(d?.result?.subdomain || "");
    ' || true)
  if [ -z "$CF_SUBDOMAIN" ]; then
    CF_SUBDOMAIN="editpeakstudio"
  fi
  DEPLOYED_WORKER_URL="https://${WORKER_NAME}.${CF_SUBDOMAIN}.workers.dev"
  green "Cloudflare account verified (subdomain: ${CF_SUBDOMAIN}.workers.dev)."
else
  echo "Using existing Cloudflare credentials stored in GitHub Secrets."
fi
STEP_PROJECT_CHECK="SUCCESS"

# --------------------------------------------------
# 4. Verify required IAM permissions and APIs
# --------------------------------------------------
echo ""
cyan "[4/10] Verifying required IAM permissions and GCP APIs..."

# Check existing GitHub variable for VITE_TELEGRAM_API_URL if not yet known
if [ -z "$DEPLOYED_WORKER_URL" ]; then
  DEPLOYED_WORKER_URL=$(gh variable get VITE_TELEGRAM_API_URL --repo "$REPO" 2>/dev/null || true)
fi

SA_LOCAL_PATH=""
if ! has_gh_secret "FIREBASE_SERVICE_ACCOUNT_SKILLFLIX_ACADEMY"; then
  echo ""
  echo "GitHub Secret FIREBASE_SERVICE_ACCOUNT_SKILLFLIX_ACADEMY is missing."
  echo "Download a Service Account JSON key from Firebase Console -> Project Settings -> Service Accounts."
  read -r -p "Enter path to Service Account JSON file: " SA_LOCAL_PATH
  if [ ! -f "$SA_LOCAL_PATH" ]; then
    red "ERROR: File not found: $SA_LOCAL_PATH"
    exit 1
  fi
  node -e '
    const fs = require("fs");
    const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (c.project_id !== process.argv[2] || !c.client_email || !c.private_key) {
      console.error("ERROR: Invalid Service Account JSON for " + process.argv[2]);
      process.exit(1);
    }
  ' "$SA_LOCAL_PATH" "$PROJECT_ID"

  # Test Google OAuth2 + Firebase Hosting/Rules/Firestore APIs directly using the provided JSON
  node -e '
    const fs = require("fs");
    const crypto = require("crypto");
    const creds = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const pk = String(creds.private_key).replace(/\\n/g, "\n");
    const now = Math.floor(Date.now() / 1000);
    const b64u = v => Buffer.from(JSON.stringify(v)).toString("base64url");
    const h = b64u({ alg: "RS256", typ: "JWT" });
    const p = b64u({
      iss: creds.client_email, sub: creds.client_email,
      aud: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase",
      iat: now, exp: now + 3600
    });
    const sig = crypto.sign("RSA-SHA256", Buffer.from(`${h}.${p}`), pk).toString("base64url");
    (async () => {
      const tr = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${h}.${p}.${sig}` })
      });
      const tj = await tr.json();
      if (!tr.ok || !tj.access_token) throw new Error("Service Account OAuth2 failed");
      const checks = [
        ["Firebase Management", "https://firebase.googleapis.com/v1beta1/projects/skillflix-academy"],
        ["Cloud Firestore", "https://firestore.googleapis.com/v1/projects/skillflix-academy/databases/(default)"],
        ["Firebase Hosting", "https://firebasehosting.googleapis.com/v1beta1/projects/skillflix-academy/sites"],
        ["Firebase Rules", "https://firebaserules.googleapis.com/v1/projects/skillflix-academy/releases"]
      ];
      for (const [name, url] of checks) {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${tj.access_token}` } });
        if (!res.ok) {
          throw new Error(`${name} API failed (HTTP ${res.status}). Grant roles/firebasehosting.admin, roles/firebaserules.admin, roles/datastore.viewer, roles/serviceusage.serviceUsageConsumer.`);
        }
        console.log("IAM/API OK:", name);
      }
    })().catch(e => { console.error(e.message); process.exit(1); });
  ' "$SA_LOCAL_PATH"
else
  echo "FIREBASE_SERVICE_ACCOUNT_SKILLFLIX_ACADEMY present in GitHub Secrets; IAM/API diagnostics will also run in CI."
fi
STEP_IAM_APIS="SUCCESS"

# --------------------------------------------------
# 5. Check and configure required secrets securely
# --------------------------------------------------
echo ""
cyan "[5/10] Checking required GitHub Secrets (values never printed)..."

if ! has_gh_secret "TELEGRAM_ENCRYPTION_KEY"; then
  ENC_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  printf '%s' "$ENC_KEY" | gh secret set TELEGRAM_ENCRYPTION_KEY --repo "$REPO"
  unset ENC_KEY
  green "Generated and stored TELEGRAM_ENCRYPTION_KEY."
fi

if [ -n "$CF_ACCOUNT_ID" ] && ! has_gh_secret "CLOUDFLARE_ACCOUNT_ID"; then
  printf '%s' "$CF_ACCOUNT_ID" | gh secret set CLOUDFLARE_ACCOUNT_ID --repo "$REPO"
  green "Stored CLOUDFLARE_ACCOUNT_ID."
fi

if [ -n "$CF_API_TOKEN" ] && ! has_gh_secret "CLOUDFLARE_API_TOKEN"; then
  printf '%s' "$CF_API_TOKEN" | gh secret set CLOUDFLARE_API_TOKEN --repo "$REPO"
  green "Stored CLOUDFLARE_API_TOKEN."
fi
unset CF_API_TOKEN || true

if [ -n "$SA_LOCAL_PATH" ]; then
  gh secret set FIREBASE_SERVICE_ACCOUNT_SKILLFLIX_ACADEMY --repo "$REPO" < "$SA_LOCAL_PATH"
  green "Stored FIREBASE_SERVICE_ACCOUNT_SKILLFLIX_ACADEMY."
fi

EXISTING_SECRETS=$(gh secret list --repo "$REPO" --json name --jq '.[].name')
for req_secret in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID TELEGRAM_ENCRYPTION_KEY FIREBASE_SERVICE_ACCOUNT_SKILLFLIX_ACADEMY; do
  if ! has_gh_secret "$req_secret"; then
    red "ERROR: Required GitHub Secret missing: $req_secret"
    exit 1
  fi
done
STEP_SECRETS="SUCCESS"
green "All required secrets verified (names only)."

# --------------------------------------------------
# 6. Deploy Cloudflare Telegram Worker (via GitHub Actions Ubuntu)
# --------------------------------------------------
echo ""
cyan "[6/10] Deploying Cloudflare Telegram Worker via GitHub Actions..."

NEED_WORKER_DEPLOY=1
if [ -n "$DEPLOYED_WORKER_URL" ]; then
  if curl -fsS "${DEPLOYED_WORKER_URL%/}/api/telegram/health" 2>/dev/null | grep -q '"runtime":"cloudflare-workers"'; then
    echo "Existing Worker already healthy at $DEPLOYED_WORKER_URL."
    if [ -d .git ] && git status --porcelain cloudflare-worker/ .github/workflows/ | grep -q .; then
      yellow "Local worker/workflow changes detected — deploying update."
    else
      NEED_WORKER_DEPLOY=0
    fi
  fi
fi

PREV_RUN_ID=$(gh run list --repo "$REPO" --workflow "$WORKFLOW_FILE" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId // ""' 2>/dev/null || true)
PUSHED_COMMIT=0
HEAD_SHA=""
if [ -d .git ]; then
  for f in deploy-all.sh scripts/deploy-all.sh .github/workflows/"$WORKFLOW_FILE" firebase.json firestore.rules src/services/telegramApi.ts cloudflare-worker; do
    if [ -e "$f" ]; then git add "$f"; fi
  done
  if ! git diff --cached --quiet; then
    git commit -m "Update Skill-Flix deployment automation"
    git push origin "$BRANCH"
    PUSHED_COMMIT=1
    NEED_WORKER_DEPLOY=1
  fi
  HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || true)
fi

if [ "$NEED_WORKER_DEPLOY" -eq 1 ]; then
  if [ "$PUSHED_COMMIT" -eq 0 ]; then
    gh workflow run "$WORKFLOW_FILE" --repo "$REPO" --ref "$BRANCH"
  fi
  RUN_ID=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 3
    if [ "$PUSHED_COMMIT" -eq 1 ] && [ -n "$HEAD_SHA" ]; then
      RUN_ID=$(gh run list --repo "$REPO" --workflow "$WORKFLOW_FILE" --branch "$BRANCH" --commit "$HEAD_SHA" --limit 1 --json databaseId --jq '.[0].databaseId // ""' 2>/dev/null || true)
    else
      CANDIDATE_ID=$(gh run list --repo "$REPO" --workflow "$WORKFLOW_FILE" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId // ""' 2>/dev/null || true)
      if [ -n "$CANDIDATE_ID" ] && [ "$CANDIDATE_ID" != "$PREV_RUN_ID" ]; then
        RUN_ID="$CANDIDATE_ID"
      fi
    fi
    if [ -n "$RUN_ID" ]; then
      break
    fi
  done
  if [ -z "$RUN_ID" ]; then
    RUN_ID=$(gh run list --repo "$REPO" --workflow "$WORKFLOW_FILE" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId // ""' 2>/dev/null || true)
  fi
  if [ -z "$RUN_ID" ]; then
    red "ERROR: Could not find triggered GitHub Actions run for $WORKFLOW_FILE."
    STEP_WORKER_DEPLOY="FAILED"
    exit 1
  fi
  echo "Monitoring GitHub Actions Run: https://github.com/$REPO/actions/runs/$RUN_ID"
  if ! gh run watch "$RUN_ID" --repo "$REPO" --exit-status; then
    red "GitHub Actions failed. Printing failed step output:"
    gh run view "$RUN_ID" --repo "$REPO" --log-failed | tail -n 80 || true
    STEP_WORKER_DEPLOY="FAILED"
    exit 1
  fi

  # Extract deployed *.workers.dev URL from run logs if not yet set
  if [ -z "$DEPLOYED_WORKER_URL" ]; then
    DEPLOYED_WORKER_URL=$(gh run view "$RUN_ID" --repo "$REPO" --log 2>/dev/null \
      | grep -Eo "https://${WORKER_NAME}\.[a-zA-Z0-9-]+\.workers\.dev" | head -n 1 || true)
  fi
fi
STEP_WORKER_DEPLOY="SUCCESS"
green "Cloudflare Telegram Worker deployment verified."

# --------------------------------------------------
# 7. Automatically configure VITE_TELEGRAM_API_URL
# --------------------------------------------------
echo ""
cyan "[7/10] Configuring VITE_TELEGRAM_API_URL..."

if [ -z "$DEPLOYED_WORKER_URL" ]; then
  red "ERROR: Could not determine deployed Worker URL automatically."
  exit 1
fi
DEPLOYED_WORKER_URL="${DEPLOYED_WORKER_URL%/}"

gh variable set VITE_TELEGRAM_API_URL --repo "$REPO" --body "$DEPLOYED_WORKER_URL" >/dev/null 2>&1 || true
printf 'VITE_TELEGRAM_API_URL="%s"\n' "$DEPLOYED_WORKER_URL" > .env.production
STEP_ENV_URL="SUCCESS"
green "Configured VITE_TELEGRAM_API_URL=$DEPLOYED_WORKER_URL"

# --------------------------------------------------
# 8. Build and deploy Firebase Hosting
# --------------------------------------------------
echo ""
cyan "[8/10] Building frontend and deploying Firebase Hosting..."

if [ ! -d node_modules ] || [ ! -x node_modules/.bin/vite ]; then
  npm install --no-audit --no-fund
fi
if [ "$IS_TERMUX" -eq 1 ] && ! node -e "require('esbuild')" >/dev/null 2>&1; then
  yellow "Installing Android ARM64 esbuild binary without modifying package.json..."
  npm install --no-save @esbuild/android-arm64 --no-audit --no-fund
fi

npm run lint
VITE_TELEGRAM_API_URL="$DEPLOYED_WORKER_URL" npm run build

if ! grep -q "$DEPLOYED_WORKER_URL" dist/assets/*.js; then
  red "ERROR: Built bundle does not contain VITE_TELEGRAM_API_URL ($DEPLOYED_WORKER_URL)."
  exit 1
fi

firebase deploy --only hosting --project "$PROJECT_ID" --non-interactive
STEP_HOSTING_DEPLOY="SUCCESS"
green "Firebase Hosting deployed."

# --------------------------------------------------
# 9. Deploy Firestore Rules
# --------------------------------------------------
echo ""
cyan "[9/10] Deploying Firestore Security Rules..."
firebase deploy --only firestore:rules --project "$PROJECT_ID" --non-interactive
STEP_RULES_DEPLOY="SUCCESS"
green "Firestore Security Rules deployed."

# --------------------------------------------------
# 10. End-to-End Live Verification
# --------------------------------------------------
echo ""
cyan "[10/10] Verifying live Worker, API JSON responses, CORS, and Hosting..."

HEALTH_JSON=$(curl -fsSL "${DEPLOYED_WORKER_URL}/api/telegram/health")
echo "$HEALTH_JSON" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (!d.ok || d.runtime !== "cloudflare-workers") process.exit(1);
'
green "Worker /api/telegram/health -> 200 OK JSON"

UNAUTH_CODE=$(curl -sS -D /tmp/sf-unauth.hdr -o /tmp/sf-unauth.json -w "%{http_code}" -X POST "${DEPLOYED_WORKER_URL}/api/telegram/bots" -H "Content-Type: application/json" -d '{}')
if [ "$UNAUTH_CODE" != "401" ] || ! grep -qi 'application/json' /tmp/sf-unauth.hdr; then
  red "ERROR: Expected 401 JSON from unauthenticated API call, got HTTP $UNAUTH_CODE"
  exit 1
fi
green "Worker API auth & JSON response check -> 401 JSON OK"

CORS_HEADERS=$(curl -sS -I -X OPTIONS "${DEPLOYED_WORKER_URL}/api/telegram/dashboard" \
  -H "Origin: ${HOSTING_URL}" \
  -H "Access-Control-Request-Method: GET" | tr -d '\r')
if ! grep -qi "access-control-allow-origin: ${HOSTING_URL}" <<< "$CORS_HEADERS"; then
  red "ERROR: Missing CORS Access-Control-Allow-Origin header for ${HOSTING_URL}"
  exit 1
fi
green "Worker CORS preflight -> OK for ${HOSTING_URL}"

HOSTING_CODE=$(curl -sS -o /tmp/sf-index.html -w "%{http_code}" "$HOSTING_URL")
if [ "$HOSTING_CODE" != "200" ]; then
  red "ERROR: Expected HTTP 200 from $HOSTING_URL, got $HOSTING_CODE"
  exit 1
fi

BUNDLE_PATH=$(grep -Eo 'assets/[^"]+\.js' /tmp/sf-index.html | head -n 1 || true)
if [ -z "$BUNDLE_PATH" ] || ! curl -fsSL "${HOSTING_URL}/${BUNDLE_PATH}" | grep -q "$DEPLOYED_WORKER_URL"; then
  red "ERROR: Live Firebase Hosting bundle (${BUNDLE_PATH:-none}) does not reference ${DEPLOYED_WORKER_URL}."
  exit 1
fi
green "Live Firebase Hosting bundle verified (${BUNDLE_PATH} -> ${DEPLOYED_WORKER_URL})"

STEP_VERIFICATION="SUCCESS"

echo ""
green "=================================================="
green " ALL DEPLOYMENTS AND CHECKS SUCCEEDED!"
green "=================================================="
echo "Worker URL:       $DEPLOYED_WORKER_URL"
echo "Hosting URL:      $HOSTING_URL"
echo "Bundle Verified:  ${HOSTING_URL}/${BUNDLE_PATH}"
echo "Firestore Rules:  Deployed to $PROJECT_ID"
