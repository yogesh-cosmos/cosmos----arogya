# COSMOS Arogya 🏥
**AI Health Companion — installable PWA**

Complete, self-contained project. Push to a new GitHub repo, connect to
Vercel, add one API key, deploy.

---

## 🩺 First stop if anything isn't working: `/api/health`

Open **`https://YOUR-SITE.vercel.app/api/health`** directly in a browser —
no login, no DevTools needed. It tells you, in plain English:
- whether `GROQ_API_KEY` is set at all
- whether it's formatted like a real key
- which AI models are currently live on your key (Groq retires models
  every few weeks — this always checks live instead of trusting a
  hard-coded name)
- a real test chat call, with the exact error if it fails
- a one-line verdict telling you exactly what to fix, if anything

Check this page **before** redeploying to "test" something — a wasted
redeploy counts against Vercel's 100/day free-tier cap.

---

## What changed in this rebuild (if you're wondering why it works now)

**Groq model names kept going stale.** Twice now, a hard-coded model id
(`qwen/qwen3.6-27b`, then `qwen/qwen3-32b`) was correct when written but
wrong by the time it was tested, because Groq deprecates models on a
rolling schedule. The fix: `api/chat.js` and `api/brand-research.js` no
longer hard-code a model. They call Groq's own `/models` endpoint first,
pick the best **currently live** one from a preference list, and
automatically fall through to the next candidate if a call fails for any
reason (decommissioned, rejects a parameter, empty reply). This should
keep working through future Groq model changes without needing another
manual fix.

**The service worker was serving stale pages forever.** The old `sw.js`
cached the app shell and then always returned the cached copy on every
future visit — so a real fix could be deployed and a returning visitor
would never see it until they manually cleared site data. This is almost
certainly why past fixes "didn't work" even when the code was correct.
Rewritten: the app shell (the page itself) is now **network-first** —
always tries to fetch the latest version, and only falls back to the
cached copy if genuinely offline. The page also now auto-reloads once
when a new service worker takes over, so a deploy is visible on next
visit without a manual hard refresh.

**Every server function now has test coverage for real failure modes** —
missing key, invalid key, a model that gets decommissioned mid-request, a
model that rejects a request parameter, a model that returns an empty
reply (common with reasoning models that use all their tokens thinking),
all Overpass mirrors being down at once, and malformed AI output. All of
these now fail *gracefully* with a clear message instead of crashing or
hanging silently.

---

## ⚠️ Two setup mistakes that will break the site if repeated

**1. Use your project's real production URL, not a preview link.**
Every Vercel deployment also gets an auto-generated URL with a random
string in it (e.g. `cosmos-arogya-drbc1o6po-yourname.vercel.app`) — these
are preview links tied to one specific deploy and can be locked behind
Vercel's own login wall. Your project has one **stable production
domain** that never changes and is public by default — find it at
Vercel Dashboard → your project → **Settings → Domains**. It has no
random middle string. Always share and test with that one.

**2. Only create ONE Vercel project per GitHub repo.**
Importing the same repo into Vercel multiple times creates separate
projects, each with its own environment variables and domain — a key
added to one won't exist in another. If you've done this before, keep
one project and delete the rest (Settings → Advanced → Delete Project).

---

## 🚀 Deploy — ~5 minutes

### 1. Get ONE free Groq key
[console.groq.com](https://console.groq.com) → sign up (email only, no
card) → **API Keys** → Create. Paste it only into Vercel, never into any
file or chat message.

### 2. Push this folder to a new GitHub repo
```bash
git init
git add .
git commit -m "COSMOS Arogya"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_NEW_REPO.git
git push -u origin main
```

### 3. Import into Vercel (once per repo)
1. [vercel.com](https://vercel.com) → New Project → Import your repo
2. **Before clicking Deploy** → Environment Variables → add
   `GROQ_API_KEY` → your key → check all three environments
3. Click **Deploy**
4. Go to **Settings → Domains**, copy the real production URL
5. Visit `<that-url>/api/health` to confirm everything is actually working

---

## 📱 Installing as an app on your phone

**Android (Chrome):** open the real production URL → an in-app "Install
COSMOS Arogya" banner appears, or Chrome's menu (⋮) → Install app.

**iPhone (Safari only):** open the link in Safari → Share → **Add to
Home Screen** → Add.

---

## Optional extra keys (not required)

`GEMINI_API_KEY` and `OPENROUTER_API_KEY` are optional backups tried only
if Groq fails entirely. The app is fully functional on Groq alone.

---

## File structure
```
cosmos-arogya/
├── index.html              ← entire app UI + logic
├── api/
│   ├── chat.js               ← AI proxy: Groq (live model discovery) → Gemini → OpenRouter → emergency fallback
│   ├── brand-research.js      ← scan-result brand ranking
│   ├── places.js               ← hospital/pharmacy finder (OpenStreetMap, 4 mirrors raced)
│   └── health.js                ← open this URL to self-diagnose, see above
├── lib/
│   └── groq.js                   ← shared: live model discovery, retry/fallback, plain-English error hints
├── icons/                          ← real PNG icons (required for install prompt)
├── manifest.json
├── sw.js                             ← network-first app shell (see "what changed" above)
├── vercel.json
├── package.json
└── README.md
```

## Features
- 🩺 **AI MediScanner** — camera, upload, or voice; medicine name, active
  ingredient, uses, adult/child/weight-based dosage, short-term side
  effects, and a separate caution card for daily/prolonged-use risk when
  relevant
- 📊 **Brand ranking** — scanned brand vs. 3-5 real alternatives with the
  same active ingredient, scored on manufacturer scale, track record,
  regulatory standing, transparency — a relative comparison among the
  brands shown, not a claim to cover the whole market
- 💬 **AI Health Chat** — multilingual, voice input
- 🔍 **Symptom Checker** — text & voice
- 🏥 **Hospital & Pharmacy Finder** — 6 categories, each a real targeted
  OpenStreetMap query that re-centers the map; tap a result for hours/
  phone/website/specialties; tapping an alternative brand jumps here
  pre-filtered to matching pharmacies
- 🌐 5 languages: English, Tamil, Hindi, Telugu, Malayalam
- 📲 Installable PWA, Android & iOS
- 🎨 Apple-inspired UI with haptic feedback

## Medical disclaimer (built into the app itself)
All AI-generated information — dosage, side effects, brand comparisons —
is general knowledge, not personalized medical advice or live market/
regulatory data. The app displays this throughout and always recommends
confirming anything important with a pharmacist or doctor.
