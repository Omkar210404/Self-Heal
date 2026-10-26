# selfheal

**Add your own API keys, GitHub token, and WhatsApp number in a `.env` file (copy `.env.example`). No real credentials are included in this repo.**

selfheal catches errors on your live website, asks you on WhatsApp whether to fix them, lets an AI write the fix on a separate branch, runs your tests, and merges only after you approve a second time.

```
 visitor's browser                 selfheal server                                   you (WhatsApp)
 ─────────────────                 ───────────────                                   ──────────────
 error / rejection / bad fetch ──► POST /api/errors ──► group into an issue ──────► 🐞 alert  [Fix it] [Ignore]
                                                                                        │
                                   AI diagnoses (stack-trace files + imports, ◄──────────┘ Fix it
                                   secrets redacted) and writes a diff
                                   │
                                   temp clone → apply → run your tests
                                   │  fail → retry with the test output (max 3 attempts)
                                   ▼  pass
                                   branch selfheal/issue-<id> → pull request ───────► ✅ fix ready  [Merge] [Reject]
                                                                                        │
                                   merge PR (your Vercel/Netlify/Actions deploy ◄────────┘ Merge
                                   takes it live), delete selfheal branch
                                                                                     ROLLBACK <id> any time
                                   revert PR opened and merged ◄─────────────────────────┘
 Any failure at any step → the issue is marked (fix_failed, merge_conflict, ...) and you get a WhatsApp message saying what failed and why.
```

## Features

- **Snippet** (`snippet/`): one script tag, no dependencies, 3.8 KB minified. Catches uncaught errors, unhandled promise rejections, failed fetch/XHR (4xx/5xx and network errors) and failed resource loads. Dedupes and batches in the browser, sends with `sendBeacon`, and everything runs inside try/catch so it can never break the page.
- **Server** (`server/`, Node.js + Express + SQLite): groups errors into issues by fingerprint (message + file + line), with counts and first/last seen. Full status history (`new → alerted → approved → fixing → fix_ready → merged / rejected / ignored / fix_failed / rolled_back`). A SQLite job queue keeps AI work off the request path and resumes after restarts.
- **WhatsApp** (Meta Cloud API): reply buttons and text commands, a signed webhook, and only your number is obeyed. Falls back to a template when the 24-hour window is closed. Retries with backoff and never sends the same alert twice; above the hourly limit, alerts are bundled into one summary. The provider sits behind an interface so others can be added.
- **AI**: Claude, Gemini and local Ollama. Tried in your chosen order, with automatic fallback, strict JSON + diff validation, and a retry when a response is malformed. Secrets are redacted before any AI call. A daily cost/call cap pauses fixing and tells you.
- **GitHub**: fine-grained token (structured so a GitHub App can replace it). Fixes go on a branch, tests run in an isolated temporary clone, and you get a PR with full details. The merge checks for conflicts first, and rollback uses a revert PR.
- **Dashboard** (`dashboard/`): password login, issue list, issue detail with full history and the AI's explanation, read-only settings with secrets masked.
- **Demo + mock mode** (`demo/`): a sample shop with a real bug and a test for it. `npm run mock` runs the entire flow locally with fake WhatsApp, fake AI and a fake GitHub, with no keys needed.

## Quick start (mock mode, no keys)

```bash
npm install
npm run mock
```

Open the links it prints:

1. **Demo site** `http://localhost:3000/demo/`: press **Checkout** (it crashes in `cart.js`).
2. **Fake phone** `http://localhost:3000/dashboard/phone` (log in with the password printed in the terminal): tap **Fix it**. The fake AI's first fix fails the demo's tests, the retry passes, a PR is opened, and **Merge** appears.
3. Tap **Merge**: the demo site is now served from the merged code, so Checkout works. Type `ROLLBACK 1` to revert it.

Mock data lives in `data/mock/`. Delete that folder to start fresh.

## Running for real

```bash
cp .env.example .env     # then fill it in (steps below)
npm start
```

At startup selfheal checks the config and lists anything missing, e.g. `No AI provider is configured`.

### 1. WhatsApp Cloud API (Meta)

1. Go to <https://developers.facebook.com/apps> → **Create app** → type **Business** → add the **WhatsApp** product.
2. **WhatsApp → API Setup**:
   - Copy the **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`.
   - Copy the **temporary access token** → `WHATSAPP_TOKEN` (it expires after 24 hours; for a permanent one create a System User in Business Settings → System users, give it the app with `whatsapp_business_messaging` + `whatsapp_business_management`, and generate a token).
   - Under **To**, click **Manage phone number list** and **add your own WhatsApp number as a test recipient**, then confirm the code WhatsApp sends you. Put it in `OWNER_WHATSAPP_NUMBER` as digits with country code, no `+` (for example `91` followed by your 10-digit number).
3. **App settings → Basic** → **App secret** → `WHATSAPP_APP_SECRET` (used to verify webhook signatures).
4. Pick any random string for `WHATSAPP_VERIFY_TOKEN`.

#### Create the template (for the 24-hour window)

WhatsApp only allows free-form messages within 24 hours of your last message to the bot. Outside that window selfheal sends an approved template instead, and resends the full alert (with buttons) as soon as you reply.

1. **WhatsApp Manager → Message templates → Create template**.
2. Category **Utility**, name `selfheal_alert`, language **English** (`en`).
3. Body: `selfheal needs your attention: {{1}}`. Give a sample value such as `New error #4: TypeError in cart.js`.
4. Submit and wait for approval (usually minutes).
5. Set `WHATSAPP_TEMPLATE_NAME=selfheal_alert`, `WHATSAPP_TEMPLATE_LANG=en`, `WHATSAPP_TEMPLATE_HAS_BODY_PARAM=true`.

To test before approval, you can use Meta's built-in `hello_world` template: `WHATSAPP_TEMPLATE_NAME=hello_world`, `WHATSAPP_TEMPLATE_LANG=en_US`, `WHATSAPP_TEMPLATE_HAS_BODY_PARAM=false`.

### 2. Webhook with ngrok

```bash
ngrok http 3000
```

Copy the `https://….ngrok-free.app` URL into `PUBLIC_URL`, restart selfheal, then in Meta: **WhatsApp → Configuration → Webhook → Edit**:

- Callback URL: `https://….ngrok-free.app/webhook/whatsapp`
- Verify token: your `WHATSAPP_VERIFY_TOKEN`
- **Manage → subscribe to `messages`**.

Free ngrok URLs change on every restart: update `PUBLIC_URL` and the callback URL each time.

### 3. AI providers (at least one)

- **Gemini**: create a key at <https://aistudio.google.com/apikey> → `GEMINI_API_KEY`. `GEMINI_MODEL` defaults to `gemini-flash-latest`.
- **Claude**: create a key at <https://console.anthropic.com/settings/keys> → `ANTHROPIC_API_KEY`. `CLAUDE_MODEL` defaults to `claude-sonnet-5-5`.
- **Ollama** (local, free): install from <https://ollama.com>, run `ollama pull qwen2.5-coder:7b`, set `OLLAMA_MODEL=qwen2.5-coder:7b`.

`AI_PROVIDERS=gemini,claude,ollama` sets the order. Providers without a key are skipped. If one fails (error, timeout, rate limit), the next one is tried.

Cost cap: `AI_DAILY_MAX_COST_USD` and `AI_DAILY_MAX_CALLS` (UTC day). Costs are estimated from the `*_PRICE_*_PER_MTOK` values; check your provider's current pricing and adjust them.

### 4. GitHub fine-grained token

<https://github.com/settings/personal-access-tokens/new>:

- **Repository access**: only your site's repository.
- **Permissions**: **Contents: Read and write**, **Pull requests: Read and write** (Metadata: read is added automatically).

Set `GITHUB_TOKEN` and `GITHUB_REPO=owner/name`. Set `TEST_COMMAND` (default `npm test`; leave it empty if the repo has no tests) and, if tests need dependencies, `INSTALL_COMMAND=npm ci`.

### 5. Install the snippet on your site

Host `snippet/dist/selfheal.min.js` with your site, or load it from your selfheal server:

```html
<script src="https://YOUR-SELFHEAL-SERVER/snippet/selfheal.min.js"
        data-endpoint="https://YOUR-SELFHEAL-SERVER/api/errors"
        data-key="YOUR_PROJECT_KEY"
        data-release="1.4.2" async></script>
```

Put it first in `<head>` so it catches early errors. Set `ALLOWED_ORIGINS` to your site's origin. The project key is visible in your page source, like any error-tracker key: it only allows sending error reports, which are rate-limited and size-limited.

If your files are served from a subfolder of the repo (e.g. `/app.js` lives at `public/app.js`), add it to `REPO_PATH_PREFIXES`. selfheal also matches by path suffix automatically.

## Testing the full WhatsApp flow with your real number

1. Complete steps 1 to 4, set `DEMO_ENABLED=true`, and point `GITHUB_REPO` at a test repository that contains the files from `demo/site/` (create a new repo and push that folder's contents to it).
2. `npm start`, then open `http://localhost:3000/demo/` and press **Checkout**.
3. You get the alert on WhatsApp. Tap **Fix it**. (If no alert arrives, send any message to the bot first to open the 24-hour window.)
4. Watch the issue page in the dashboard. You'll get **Fix ready** with the PR link. Review the PR on GitHub, then tap **Merge**.
5. Reply `ROLLBACK 1` to test the revert.
6. Text commands work too: `YES 1`, `NO 1`, `MERGE 1`, `REJECT 1`, `ROLLBACK 1`, `STATUS 1`, `HELP`.

**Settings → Send a test WhatsApp message** checks your token, phone number ID and recipient without needing an error.

## Tests

```bash
npm test            # everything (unit + end-to-end)
npm run test:unit
npm run test:e2e    # full mock-mode flow + failure paths
npm run build:snippet
npm run scan        # secret scan: staged files + full git history
```

The end-to-end test runs a real server, SQLite, the queue, git and the demo repo's own tests, and fakes only WhatsApp, the AI and the GitHub API. It covers error → issue → alert → approve → AI fix → test fail → retry → pass → PR → merge → rollback, and the failure paths: all AI providers down, tests failing 3 times, WhatsApp send failures, a closed 24-hour window, merge conflicts, and the cost cap.

## Safety

- **Two approval gates.** Nothing is changed until you tap **Fix it**, and nothing is merged until you tap **Merge**. Only `OWNER_WHATSAPP_NUMBER` is obeyed; messages from anyone else are ignored and logged with the number masked. Every webhook's Meta signature is verified.
- **Never on main.** Fixes go to `selfheal/issue-<id>` branches through pull requests. selfheal never pushes to the base branch, never force-pushes, and only deletes its own `selfheal/*` branches. Before merging it checks the PR is still mergeable; if there is a conflict it tells you instead of forcing.
- **What the AI never sees or changes:** `.env*` files, lock files, keys/certificates/credentials, CI and deploy config (`.github/`, `vercel.json`, `netlify.toml`, Dockerfiles, ...), `.git`, `node_modules`, and anything in `DENYLIST`. Tests and `package.json` can be read but never changed, so the AI can't "fix" a bug by editing the test. Add more with `READONLY_PATHS`.
- **Redaction.** Before any AI call, secrets, tokens, keys, emails and phone numbers in code and error data are replaced with placeholders. The originals are restored only in the local file.
- **Limits:** `FIX_MAX_FILES`, `FIX_MAX_LINES` and `FIX_MAX_ATTEMPTS`. A fix that is too big is rejected. Daily AI cost/call caps pause fixing.
- **Test isolation:** the repo is cloned to a temp folder and the test command runs with a minimal environment, with none of selfheal's tokens. It still runs your repository's code on this machine, so only connect repositories you trust.
- **Secrets:** they live only in `.env` (git-ignored), and logs mask phone numbers and tokens. `npm run hooks` enables a pre-commit hook that scans staged files and the full history.

## Troubleshooting

| Problem | Fix |
|---|---|
| **WhatsApp messages not arriving** | Check the dashboard banner and the issue's *WhatsApp messages* table for the exact error. `131030` = your number isn't in the test-recipient list (step 1.2). `190` = token expired. Use **Settings → Send a test WhatsApp message**. |
| **Only a template arrives / "24-hour window"** | That's expected after 24 hours of silence. Reply anything and the full alert with buttons is resent. If templates fail with `132001`, the template isn't approved yet or the language code is wrong. |
| **Button taps do nothing** | The webhook isn't reaching you: check the ngrok URL in Meta matches `PUBLIC_URL`, that the `messages` field is subscribed, and that `WHATSAPP_APP_SECRET` is right (wrong secret = `401` in the logs). |
| **AI provider failures** | The failure message lists each provider's reason. `auth` = bad key, `rate_limit` = quota, `unavailable` for Ollama = not running (`ollama serve`) or model not pulled. |
| **"Could not map the error to any source file"** | Your served paths differ from repo paths: add the folder to `REPO_PATH_PREFIXES`. Minified bundles give poor stack traces; errors in readable source files fix best. |
| **Merge conflict** | Someone changed the same lines on main. Resolve on GitHub and reply `MERGE <id>`, or `REJECT <id>` then `FIX <id>` for a fresh fix. |
| **Paused: daily AI limit** | Fixing resumes automatically at 00:00 UTC, or raise `AI_DAILY_MAX_COST_USD` / `AI_DAILY_MAX_CALLS` and restart. |

## Project layout

```
snippet/    browser snippet (src + minified dist, build script)
server/     Express app, ingest, issues, queue, WhatsApp (notify/), AI (ai.js), fix engine (fix.js), GitHub (repo.js), workflow
dashboard/  server-rendered dashboard
demo/       sample shop with a deliberate bug and its test
tests/      unit + end-to-end tests
scripts/    secret scanner
```
