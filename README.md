# 🥑 PantryPilot — Hybrid AI Food-Rescue Planner

**Your pantry, thought through on-device first.**

PantryPilot watches the expiry dates in your kitchen, ranks the food that is about to be
wasted, and turns it into tonight's dinner — planned by **Firebase AI Logic hybrid
inference**: **Gemini Nano** answers on-device in Chrome when it can (fast, private,
offline, free), and the *same SDK call* falls back to **cloud Gemini** on every other
device. One prompt, two possible brains — and the UI shows you which one answered.

Built for **#BuildHybridAI 2026** (Google + Firebase, on Devpost) · Platform: **Web (Chrome)** · License: MIT

---

## The problem

Households throw away food not because they lack recipes, but because they lose track of
what is about to expire. By the time the spinach is found, it's compost. The fix is a
watchman, not a cookbook — and the watchman sees the most private dataset in your home:
what you eat, and what you can afford. Questions like *"what do I cook with what's dying
in my fridge tonight?"* should not have to leave the device. But they still need a good
answer on devices that have no local model. That is exactly the shape of hybrid inference.

## What PantryPilot does

1. **Pantry inventory** — add items with quantity, category, price and expiry date.
   Stored in the browser (localStorage); optionally synced to **Firestore** under an
   anonymous **Firebase Authentication** identity.
2. **Deterministic Rescue Engine** (`docs/engine.js`) — no AI, no network, fully
   unit-tested. Computes days-left, a 0–100 risk score per item (expiry proximity ×
   category perishability × quantity), the **rescue queue** for the next N days
   (N is a **Remote Config** parameter), and the **money at risk** this week.
3. **Hybrid AI rescue plan** (`docs/hybrid-ai.js`) — one click builds a prompt from the
   rescue queue and calls a Firebase AI Logic `GenerativeModel` created with a hybrid
   `InferenceMode`:
   - `PREFER_ON_DEVICE` (default): Gemini Nano on-device → cloud Gemini fallback.
   - `ONLY_ON_DEVICE`: privacy mode — on-device or an honest error.
   - `PREFER_IN_CLOUD`: cloud Gemini first, on-device when offline.
   The answer is **structured JSON on both paths** (cloud: `responseSchema`; on-device:
   `responseConstraint`): a dinner title, steps, which urgent items it uses, and what is
   missing — missing items flow into the shopping list with one tap.
4. **Visible routing** — every plan carries a badge: *Served ON-DEVICE · Gemini Nano*,
   *Served in CLOUD · Gemini*, or *Local preview*. Latency is shown. Hybrid inference is
   the product, not a black box.
5. **App Check** protects the AI endpoint (debug-token flow for this submission build —
   explicitly accepted by the hackathon rules; a reCAPTCHA v3 provider is used
   automatically when a site key is configured).

## How Firebase AI Logic is used at runtime (for judges)

The Firebase AI Logic SDK is imported and actually called in `docs/hybrid-ai.js`:

```js
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, Schema } from "firebase/ai";

const ai = getAI(firebaseApp, { backend: new GoogleAIBackend() });
const model = getGenerativeModel(ai, {
  mode: InferenceMode.PREFER_ON_DEVICE,               // hybrid routing
  inCloudParams: { model: "gemini-2.5-flash",
                   generationConfig: { responseMimeType: "application/json", responseSchema } },
  onDeviceParams: { promptOptions: { responseConstraint: responseSchema } }
});
await model.initializeDeviceModel(onProgress);        // after the user's click
const result = await model.generateContent(prompt); // one call — device OR cloud
```

Also used at runtime: `firebase/app-check` (init + debug provider flow),
`firebase/auth` (anonymous sign-in), `firebase/firestore` (`setDoc`/`getDoc` pantry
sync), `firebase/remote-config` (`fetchAndActivate`, `rescue_threshold_days`,
`default_inference_mode`).

## Honesty: what is live vs. local preview

This submission build ships wired to a live demo Firebase project
(`pantrypilot-27f6e`, Spark/no-cost plan) in `docs/firebase-config.js`, so the
hosted demo runs the real hybrid path. If you fork the repo and blank the
config back to placeholders, the app runs in **local mode**:

- ✅ Fully live: inventory, rescue engine, risk scores, money-at-risk, shopping list,
  and a **deterministic local preview plan** — always badged *"Local preview"*.
- 🔌 Activates the moment a real config is pasted in (5-minute setup below): Firebase
  AI Logic hybrid inference, App Check, anonymous auth, Firestore sync, Remote Config.

Nothing in the app or this README claims a local preview is a Gemini answer.

## Run it locally (no Firebase needed)

```bash
npm run serve          # python3 http server for docs/ on :8931
# open http://localhost:8931
npm test               # unit tests for the rescue engine (node --test)
```

## Go hybrid: connect your Firebase project (±5 minutes, free)

1. Go to the [Firebase console](https://console.firebase.google.com) → **Add project**
   (Google Analytics not required).
2. In the project: **AI Services → AI Logic → Get started**. Choose the
   **Gemini Developer API** provider (free tier). The guided flow enables the APIs and
   enforces App Check.
3. **Project settings → Your apps → Web app (`</>`)** → register the app, copy the
   `firebaseConfig` object into `docs/firebase-config.js`.
4. **App Check debug token** (submission/dev flow): open the app, look in the browser
   console for `AppCheck debug token: "…"`, then in the console go to
   **App Check → Apps → (your web app) → Manage debug tokens** and register it.
5. *(Optional)* **Firestore**: create the database (production mode) and add rules that
   scope each pantry to its anonymous owner:
   ```
   match /pantries/{uid} {
     allow read, write: if request.auth != null && request.auth.uid == uid;
   }
   ```
6. *(Optional)* **Remote Config**: add `rescue_threshold_days` (number, default `7`)
   and `default_inference_mode` (string, default `PREFER_ON_DEVICE`).
7. For on-device inference: use **Chrome desktop ≥ 139**, enable
   `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input`, restart, and let the
   model download on first use (the app shows download progress).

## Deploy the demo (GitHub Pages)

The whole app is the static `docs/` folder — enable GitHub Pages from the `docs/`
folder of the default branch and the demo is live. No build step.

## Project structure

```
docs/
  index.html          product UI (inventory, rescue queue, planner, shopping list)
  styles.css
  engine.js           deterministic rescue engine (browser + Node, unit-tested)
  app.js              UI glue, state, honest fallback labelling
  hybrid-ai.js        Firebase AI Logic hybrid inference + App Check/Auth/Firestore/RC
  firebase-config.js  live demo project config (fork: paste your own project's)
test/
  engine.test.js      node:test suite for the engine (9 tests)
```

## Tech stack

Firebase AI Logic (Web SDK 12.5.0+) · Gemini Nano (Chrome Prompt API) · Gemini 2.5
Flash (cloud, Gemini Developer API free tier) · App Check · Firestore · Firebase
Authentication · Remote Config · Vanilla JS/CSS (no build step) · Node test runner.

## License

MIT — see `LICENSE`.
