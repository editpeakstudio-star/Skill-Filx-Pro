# Skill-Flix Telegram Payment Bot — Cloudflare Workers Free Tier

Zero-cost backend for Skill-Flix Multi Telegram Bot Payment Notifications running on **Cloudflare Workers Free Tier** + **Firebase Spark (Free Tier)**.

## Prerequisites (100% Free)
1. **Firebase Spark Project**: `skillflix-academy` (Auth + Firestore + Hosting)
2. **Firebase Service Account JSON** (Free on Spark):
   - Firebase Console → Project Settings (`skillflix-academy`) → **Service Accounts** → **Generate new private key**
   - Copy `"client_email"` and `"private_key"` from the downloaded JSON file.
3. **Cloudflare Free Account**: `https://dash.cloudflare.com/sign-up`

## Termux (Android) Compatibility Notes
- This worker has **zero runtime npm dependencies** (`fetch` + Web Crypto API only).
- If `wrangler` needs `esbuild` on Android ARM64 Termux, install Termux's native esbuild package or `@esbuild/android-arm64`:
  ```bash
  pkg install -y nodejs-lts git
  ```
  If `npm install` hits an esbuild platform warning on Termux, run:
  ```bash
  npm install --no-audit --no-fund --ignore-scripts
  npm install -D @esbuild/android-arm64
  ```

## Step 1: Install Worker Dependencies & Login
```bash
cd cloudflare-worker
npm install --no-audit --no-fund
npx wrangler login
```

## Step 2: Set Encrypted Worker Secrets
Generate a 64-character hex encryption key (same key format as Express server):
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Upload the required secrets to Cloudflare Workers:
```bash
npx wrangler secret put TELEGRAM_ENCRYPTION_KEY
npx wrangler secret put FIREBASE_CLIENT_EMAIL
npx wrangler secret put FIREBASE_PRIVATE_KEY
```
When prompted for `FIREBASE_PRIVATE_KEY`, paste the entire PEM block from `"private_key"` in your Service Account JSON (or replace `\n` with actual newlines).

*(Optional)* Store a default fallback Telegram Bot Token & Chat ID strictly in Cloudflare Worker Secrets (used automatically whenever no Firestore bots are active):
```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

## Step 3: Deploy Cloudflare Worker
```bash
npx wrangler deploy
```
Copy the printed `*.workers.dev` URL, e.g.:
`https://skill-flix-telegram-api.<your-subdomain>.workers.dev`

Verify it is live:
```bash
curl https://skill-flix-telegram-api.<your-subdomain>.workers.dev/api/telegram/health
```

## Step 4: Connect Frontend & Deploy Firebase Hosting (Spark Free Tier)
Return to the repo root, create `.env.production` with your Worker URL, build, and deploy:
```bash
cd ..
echo 'VITE_TELEGRAM_API_URL="https://skill-flix-telegram-api.<your-subdomain>.workers.dev"' > .env.production
npm run build
npx firebase deploy --only hosting,firestore:rules
```
