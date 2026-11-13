#!/usr/bin/env bash
set -euo pipefail

REPO="editpeakstudio-star/Skill-Filx-Pro"
BRANCH="main"
PROJECT_ID="skillflix-academy"
WORKFLOW_FILE="deploy-telegram-worker.yml"

echo "=========================================="
echo " Skill-Flix One-Command DevOps Setup"
echo " Repo: $REPO ($BRANCH)"
echo " Firebase: $PROJECT_ID"
echo "=========================================="

for cmd in git node npm curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: '$cmd' not found. In Termux run: pkg install -y git nodejs-lts curl"
    exit 1
  fi
done

if ! command -v gh >/dev/null 2>&1; then
  echo "INFO: GitHub CLI ('gh') not found. In Termux run: pkg install -y gh"
  exit 1
fi

# 1. Authenticate GitHub CLI if needed
if ! gh auth status >/dev/null 2>&1; then
  echo ""
  echo "[1/5] Opening GitHub CLI login..."
  gh auth login --web --git-protocol https
fi
gh auth setup-git >/dev/null 2>&1 || true

# 2. Authenticate Cloudflare Wrangler if needed
echo ""
echo "[2/5] Checking Cloudflare authentication..."
pushd cloudflare-worker >/dev/null
if [ ! -d node_modules ]; then
  npm install --no-audit --no-fund
fi
if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "Opening Cloudflare login..."
  npx wrangler login
fi
popd >/dev/null

# 3. Check & set GitHub Secrets securely via gh CLI (never echoed)
echo ""
echo "[3/5] Checking GitHub Actions Secrets on $REPO..."
EXISTING_SECRETS=$(gh secret list --repo "$REPO" --json name --jq '.[].name' || true)

has_secret() {
  echo "$EXISTING_SECRETS" | grep -qx "$1"
}

if ! has_secret "TELEGRAM_ENCRYPTION_KEY"; then
  echo "Generating a fresh 64-hex TELEGRAM_ENCRYPTION_KEY..."
  ENC_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  printf '%s' "$ENC_KEY" | gh secret set TELEGRAM_ENCRYPTION_KEY --repo "$REPO"
  unset ENC_KEY
  echo "Set TELEGRAM_ENCRYPTION_KEY."
fi

if ! has_secret "FIREBASE_SERVICE_ACCOUNT_SKILLFLIX_ACADEMY"; then
  echo ""
  read -r -p "Path to Firebase Service Account JSON file (from Firebase Console): " SA_PATH
  if [ ! -f "$SA_PATH" ]; then
    echo "ERROR: File not found: $SA_PATH"
    exit 1
  fi
  gh secret set FIREBASE_SERVICE_ACCOUNT_SKILLFLIX_ACADEMY --repo "$REPO" < "$SA_PATH"
  echo "Set FIREBASE_SERVICE_ACCOUNT_SKILLFLIX_ACADEMY."
fi

if ! has_secret "CLOUDFLARE_ACCOUNT_ID"; then
  echo ""
  read -r -p "Enter your 32-char Cloudflare Account ID: " CF_ACC_ID
  printf '%s' "$CF_ACC_ID" | gh secret set CLOUDFLARE_ACCOUNT_ID --repo "$REPO"
  echo "Set CLOUDFLARE_ACCOUNT_ID."
fi

if ! has_secret "CLOUDFLARE_API_TOKEN"; then
  echo ""
  read -r -s -p "Enter your Cloudflare API Token (Workers Scripts:Edit + Account Settings:Read): " CF_TOK
  echo ""
  printf '%s' "$CF_TOK" | gh secret set CLOUDFLARE_API_TOKEN --repo "$REPO"
  unset CF_TOK
  echo "Set CLOUDFLARE_API_TOKEN."
fi

# 4. Push workflow & changes if inside git checkout
echo ""
echo "[4/5] Syncing branch '$BRANCH'..."
if [ -d .git ]; then
  git add .github/workflows/deploy-telegram-worker.yml firebase.json firestore.rules src/services/telegramApi.ts cloudflare-worker/
  if ! git diff --cached --quiet; then
    git commit -m "Configure verified Cloudflare Worker + Firebase Hosting CI/CD"
    git push origin "$BRANCH"
  else
    echo "No local git diff to commit."
  fi
else
  echo "Not inside a local git clone; ensure .github/workflows/deploy-telegram-worker.yml is copied into your clone before pushing."
fi

# 5. Trigger GitHub Actions deployment and watch live status
echo ""
echo "[5/5] Triggering GitHub Actions workflow '$WORKFLOW_FILE'..."
gh workflow run "$WORKFLOW_FILE" --repo "$REPO" --ref "$BRANCH"
sleep 4
RUN_ID=$(gh run list --repo "$REPO" --workflow "$WORKFLOW_FILE" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')
echo "Live Run URL: https://github.com/$REPO/actions/runs/$RUN_ID"
gh run watch "$RUN_ID" --repo "$REPO" --exit-status

echo ""
echo "DEPLOYMENT VERIFIED SUCCESSFULLY!"
