#!/usr/bin/env bash
set -euo pipefail

REPO="editpeakstudio-star/Skill-Filx-Pro"
BRANCH="main"
PROJECT_ID="skillflix-academy"
WORKFLOW_FILE="deploy-telegram-worker.yml"

echo "=================================================="
echo " Skill-Flix Termux / Linux CI/CD Deployment"
echo " Repo:     $REPO ($BRANCH)"
echo " Firebase: $PROJECT_ID"
echo " Runner:   GitHub Actions (ubuntu-latest)"
echo "=================================================="
echo "Note: Local Wrangler/workerd is skipped (unsupported on Android ARM64)."
echo "      All Cloudflare Worker builds & deploys run on GitHub Actions Ubuntu."

# 1. Validate prerequisites (no Wrangler or native Android binaries required)
for cmd in git node curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: '$cmd' is missing. In Termux run: pkg install -y git nodejs-lts curl"
    exit 1
  fi
done

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: GitHub CLI ('gh') is missing. In Termux run: pkg install -y gh"
  exit 1
fi

for req_file in \
  ".github/workflows/$WORKFLOW_FILE" \
  "firebase.json" \
  "firestore.rules" \
  "cloudflare-worker/wrangler.toml" \
  "cloudflare-worker/src/index.ts"; do
  if [ ! -f "$req_file" ]; then
    echo "ERROR: Required file missing: $req_file"
    exit 1
  fi
done

# 2. Authenticate GitHub CLI if needed
if ! gh auth status >/dev/null 2>&1; then
  echo ""
  echo "[1/4] Opening GitHub CLI login..."
  gh auth login --web --git-protocol https
fi
gh auth setup-git >/dev/null 2>&1 || true

# 3. Validate & set required GitHub Secrets securely (never echoed)
echo ""
echo "[2/4] Verifying GitHub Actions Secrets on $REPO..."
EXISTING_SECRETS=$(gh secret list --repo "$REPO" --json name --jq '.[].name' || true)

has_secret() {
  echo "$EXISTING_SECRETS" | grep -qx "$1"
}

if ! has_secret "TELEGRAM_ENCRYPTION_KEY"; then
  echo "Generating fresh 64-hex TELEGRAM_ENCRYPTION_KEY..."
  ENC_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  printf '%s' "$ENC_KEY" | gh secret set TELEGRAM_ENCRYPTION_KEY --repo "$REPO"
  unset ENC_KEY
  echo "Configured TELEGRAM_ENCRYPTION_KEY."
fi

if ! has_secret "FIREBASE_SERVICE_ACCOUNT_SKILLFLIX_ACADEMY"; then
  echo ""
  read -r -p "Path to Firebase Service Account JSON file (for $PROJECT_ID): " SA_PATH
  if [ ! -f "$SA_PATH" ]; then
    echo "ERROR: File not found: $SA_PATH"
    exit 1
  fi
  node -e '
    const fs = require("fs");
    const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (c.project_id !== process.argv[2] || !c.client_email || !c.private_key) {
      console.error("ERROR: Invalid Service Account JSON for project " + process.argv[2]);
      process.exit(1);
    }
  ' "$SA_PATH" "$PROJECT_ID"
  gh secret set FIREBASE_SERVICE_ACCOUNT_SKILLFLIX_ACADEMY --repo "$REPO" < "$SA_PATH"
  echo "Configured FIREBASE_SERVICE_ACCOUNT_SKILLFLIX_ACADEMY."
fi

if ! has_secret "CLOUDFLARE_ACCOUNT_ID"; then
  echo ""
  read -r -p "Enter 32-char Cloudflare Account ID: " CF_ACC_ID
  CF_ACC_ID=$(printf '%s' "$CF_ACC_ID" | tr -d '[:space:]')
  if ! printf '%s' "$CF_ACC_ID" | grep -Eq '^[a-fA-F0-9]{32}$'; then
    echo "ERROR: CLOUDFLARE_ACCOUNT_ID must be a 32-character hex string."
    exit 1
  fi
  printf '%s' "$CF_ACC_ID" | gh secret set CLOUDFLARE_ACCOUNT_ID --repo "$REPO"
  unset CF_ACC_ID
  echo "Configured CLOUDFLARE_ACCOUNT_ID."
fi

if ! has_secret "CLOUDFLARE_API_TOKEN"; then
  echo ""
  read -r -s -p "Enter Cloudflare API Token (Workers Scripts:Edit + Account Settings:Read): " CF_TOK
  echo ""
  CF_TOK=$(printf '%s' "$CF_TOK" | tr -d '[:space:]')
  if [ -z "$CF_TOK" ]; then
    echo "ERROR: CLOUDFLARE_API_TOKEN cannot be empty."
    exit 1
  fi
  # Validate token against Cloudflare API without logging the token
  VERIFY_OK=$(curl -fsS "https://api.cloudflare.com/client/v4/user/tokens/verify" \
    -H "Authorization: Bearer ${CF_TOK}" 2>/dev/null | node -e '
      const d = JSON.parse(require("fs").readFileSync(0, "utf8") || "{}");
      process.stdout.write(d.success ? "1" : "0");
    ' || echo "0")
  if [ "$VERIFY_OK" != "1" ]; then
    unset CF_TOK
    echo "ERROR: Cloudflare rejected CLOUDFLARE_API_TOKEN. Check permissions and try again."
    exit 1
  fi
  printf '%s' "$CF_TOK" | gh secret set CLOUDFLARE_API_TOKEN --repo "$REPO"
  unset CF_TOK
  echo "Verified & configured CLOUDFLARE_API_TOKEN."
fi

# 4. Commit and push updates to main
echo ""
echo "[3/4] Committing and pushing deployment updates to '$BRANCH'..."
if [ ! -d .git ]; then
  echo "ERROR: Current directory is not a git clone. Run this inside your cloned $REPO repository."
  exit 1
fi

STAGE_PATHS=(
  ".github/workflows/$WORKFLOW_FILE"
  "scripts/deploy-all.sh"
  "firebase.json"
  "firestore.rules"
  "src/services/telegramApi.ts"
  "cloudflare-worker"
  ".env.example"
  ".gitignore"
  "tsconfig.json"
)

EXISTING_STAGE=()
for p in "${STAGE_PATHS[@]}"; do
  if [ -e "$p" ]; then
    EXISTING_STAGE+=("$p")
  fi
done

if [ "${#EXISTING_STAGE[@]}" -gt 0 ]; then
  git add "${EXISTING_STAGE[@]}"
fi

PUSHED_NEW_COMMIT=0
if ! git diff --cached --quiet; then
  git commit -m "Fix Termux deploy script and harden Cloudflare/Firebase CI/CD"
  git push origin "$BRANCH"
  PUSHED_NEW_COMMIT=1
else
  echo "Working tree already clean for deployment files."
fi

# 5. Trigger GitHub Actions workflow on Ubuntu runner and watch live logs
echo ""
echo "[4/4] Starting and monitoring GitHub Actions ($WORKFLOW_FILE)..."
if [ "$PUSHED_NEW_COMMIT" -eq 0 ]; then
  gh workflow run "$WORKFLOW_FILE" --repo "$REPO" --ref "$BRANCH"
fi

sleep 5
RUN_ID=$(gh run list --repo "$REPO" --workflow "$WORKFLOW_FILE" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')
if [ -z "$RUN_ID" ]; then
  echo "ERROR: Could not locate triggered GitHub Actions run ID."
  exit 1
fi

echo "Live Run URL: https://github.com/$REPO/actions/runs/$RUN_ID"
if ! gh run watch "$RUN_ID" --repo "$REPO" --exit-status; then
  echo ""
  echo "Deployment failed. Summary of failed steps:"
  gh run view "$RUN_ID" --repo "$REPO" --log-failed | tail -n 80 || true
  exit 1
fi

echo ""
echo "=================================================="
echo " DEPLOYMENT VERIFIED SUCCESSFULLY!"
echo " Hosting: https://$PROJECT_ID.web.app"
echo " Actions: https://github.com/$REPO/actions/runs/$RUN_ID"
echo "=================================================="
