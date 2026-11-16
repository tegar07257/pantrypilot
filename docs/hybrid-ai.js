/*
 * PantryPilot — Hybrid AI layer (Firebase AI Logic)
 * --------------------------------------------------
 * This is the hackathon core: real Firebase AI Logic hybrid inference.
 *
 *   import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, Schema }
 *     from "firebase/ai"
 *
 * One GenerativeModel is created with a hybrid InferenceMode:
 *   - PREFER_ON_DEVICE : Gemini Nano (Chrome Prompt API) first,
 *                        automatic fallback to cloud Gemini.
 *   - ONLY_ON_DEVICE   : on-device or an error — for the privacy demo.
 *   - PREFER_IN_CLOUD  : cloud Gemini first, on-device when offline.
 *
 * Structured output is requested on BOTH paths: the cloud model gets
 * `responseMimeType: "application/json"` + `responseSchema`, the
 * on-device model gets the same schema as a `responseConstraint`.
 *
 * Also wired here (all real, all optional-at-runtime):
 *   - App Check (Google Cloud Fraud Defense / reCAPTCHA Enterprise
 *     provider, active when a site key is configured in
 *     firebase-config.js; site keys are public, the secret lives only
 *     in the Firebase console — no debug token is ever committed)
 *   - Authentication (anonymous sign-in) + Firestore pantry sync
 *   - Remote Config (rescue threshold + default inference mode,
 *     changeable without redeploying)
 *
 * Everything degrades honestly: if the Firebase config is still a
 * placeholder, or the SDK/model is unavailable, callers get
 * { configured:false } / a thrown error and the UI falls back to the
 * deterministic local preview — labelled as such, never disguised.
 */

const SDK_VERSION = "12.5.0"; // first Web SDK line with hybrid on-device support
const CDN = `https://www.gstatic.com/firebasejs/${SDK_VERSION}/`;

const state = {
  configured: false,
  app: null,
  ai: null,
  mods: null, // loaded firebase modules
  user: null,
  remoteConfig: { rescueThresholdDays: 7, defaultMode: "PREFER_ON_DEVICE" },
  deviceModelReady: false
};

function isPlaceholder(cfg) {
  return !cfg || !cfg.apiKey || cfg.apiKey.indexOf("YOUR_") === 0;
}

/** Load the modular Firebase SDK from the official CDN. */
async function loadSdk() {
  if (state.mods) return state.mods;
  const [appMod, aiMod, appCheckMod, authMod, fsMod, rcMod] = await Promise.all([
    import(CDN + "firebase-app.js"),
    import(CDN + "firebase-ai.js"),
    import(CDN + "firebase-app-check.js"),
    import(CDN + "firebase-auth.js"),
    import(CDN + "firebase-firestore.js"),
    import(CDN + "firebase-remote-config.js")
  ]);
  state.mods = { appMod, aiMod, appCheckMod, authMod, fsMod, rcMod };
  return state.mods;
}

/**
 * Initialize Firebase + AI Logic. Safe to call repeatedly.
 * Returns { configured:boolean, reason?:string }.
 */
export async function initHybridAI(onStatus) {
  const cfg = window.PANTRYPILOT_FIREBASE_CONFIG;
  if (isPlaceholder(cfg)) {
    return { configured: false, reason: "Firebase config is still a placeholder — running in local mode." };
  }
  if (state.configured) return { configured: true };

  const { appMod, aiMod, appCheckMod, authMod, rcMod } = await loadSdk();

  state.app = appMod.initializeApp(cfg);

  // --- App Check -----------------------------------------------------
  // Provider: Google Cloud Fraud Defense (reCAPTCHA Enterprise).
  // Firebase no longer accepts new reCAPTCHA Classic registrations,
  // and a debug token must never be committed to a public repo (one
  // was, briefly, on 2026-11-15 — it was revoked in the console the
  // same morning; see git history). The site key in the config is a
  // public identifier; the secret key exists only in the console.
  try {
    if (cfg.appCheckSiteKey) {
      appCheckMod.initializeAppCheck(state.app, {
        provider: new appCheckMod.ReCaptchaEnterpriseProvider(cfg.appCheckSiteKey),
        isTokenAutoRefreshEnabled: true
      });
      onStatus && onStatus("App Check: Fraud Defense (reCAPTCHA Enterprise) provider active.");
    } else {
      onStatus && onStatus("App Check: not initialized (no provider site key configured).");
    }
  } catch (e) {
    onStatus && onStatus("App Check init skipped: " + e.message);
  }

  // --- Firebase AI Logic (Gemini Developer API backend) --------------
  state.ai = aiMod.getAI(state.app, { backend: new aiMod.GoogleAIBackend() });

  // --- Auth: anonymous, so Firestore sync has an identity ------------
  try {
    const auth = authMod.getAuth(state.app);
    const cred = await authMod.signInAnonymously(auth);
    state.user = cred.user;
  } catch (e) {
    onStatus && onStatus("Anonymous auth skipped: " + e.message);
  }

  // --- Remote Config: tunables without redeploy ----------------------
  try {
    const rc = rcMod.getRemoteConfig(state.app);
    rc.settings.minimumFetchIntervalMillis = 60 * 1000;
    rc.defaultConfig = { rescue_threshold_days: 7, default_inference_mode: "PREFER_ON_DEVICE" };
    await rcMod.fetchAndActivate(rc);
    state.remoteConfig.rescueThresholdDays = rcMod.getNumber(rc, "rescue_threshold_days") || 7;
    state.remoteConfig.defaultMode = rcMod.getString(rc, "default_inference_mode") || "PREFER_ON_DEVICE";
  } catch (e) {
    onStatus && onStatus("Remote Config skipped: " + e.message);
  }

  state.configured = true;
  return { configured: true };
}

export function getRemoteConfig() {
  return state.remoteConfig;
}

function planSchema(Schema) {
  return Schema.object({
    properties: {
      title: Schema.string(),
      summary: Schema.string(),
      steps: Schema.array({ items: Schema.string() }),
      usesItems: Schema.array({ items: Schema.string() }),
      missingItems: Schema.array({ items: Schema.string() }),
      timeMinutes: Schema.number(),
      servings: Schema.number()
    }
  });
}

/**
 * Build the hybrid GenerativeModel for a given mode and initialize
 * the on-device model when the SDK exposes that path.
 * initializeDeviceModel() is only present where on-device inference
 * is supported (Chrome on desktop, Prompt API); on other browsers
 * (e.g. Chrome on Android) the method is absent and generateContent()
 * performs the cloud fallback itself for the PREFER_* modes — so the
 * call is guarded and its absence/failure never blocks a cloud plan.
 * This function is only invoked from the button click handler, which
 * satisfies the user-activation requirement for device init.
 */
// Cloud model name. NOTE (2026-11-15): the API retired
// gemini-2.5-flash for new users (404 "no longer available to new
// users — use models/gemini-3.8-flash"), so 3.8 Flash it was.
// UPDATE (2026-11-16): staged diagnostics (docs/diag.html) proved
// generateContent on gemini-3.8-flash — and gemini-3.7-flash — hangs
// server-side for this project (never settles, 3 separate runs), while
// gemini-3.5-flash answered in ~2.1s and gemini-3.5-flash-lite in
// ~3.4s. The full 3.5 Flash is the working, stronger model, so it is
// now the cloud model. Round 3 of the diagnostics then showed WHY the
// first badge test still failed on 3.5 Flash: with the app's schema
// call the model spent the 1024-token output budget on hidden
// reasoning and returned a 106-character JSON stub
// (finishReason=MAX_TOKENS) — on the app's longer real prompt it
// returned nothing at all. Hence the raised maxOutputTokens in
// cloudGenerationConfig below; the lite model completed the same
// call within budget (finishReason=STOP, valid JSON) and remains the
// fallback if the full model misbehaves again.
const CLOUD_MODEL = "gemini-3.5-flash";

async function getHybridModel(modeName, onProgress) {
  const { aiMod } = state.mods;
  const { InferenceMode } = aiMod;
  const mode = InferenceMode[modeName] || InferenceMode.PREFER_ON_DEVICE;
  const schema = planSchema(aiMod.Schema);
  const cloudGenerationConfig = {
    responseMimeType: "application/json",
    responseSchema: schema,
    temperature: 0.6,
    // 8192, not 1024: diag round 3 (2026-11-16) caught gemini-3.5-flash
    // truncating the plan JSON at 106 chars with finishReason
    // MAX_TOKENS under a 1024 budget — the budget is shared with the
    // model's hidden reasoning tokens, so the visible JSON needs far
    // more headroom than the plan's own ~1-2k tokens.
    maxOutputTokens: 8192
  };

  // "Cloud first" uses a plain cloud-only model — no hybrid routing —
  // so nothing on the (possibly absent or flag-disabled) on-device
  // path can block a cloud answer. Verified need 2026-11-15: the
  // hybrid PREFER_IN_CLOUD route died with "The feature flag gating
  // model execution was disabled" in a browser without a usable
  // Prompt API, before any network call.
  if (modeName === "PREFER_IN_CLOUD") {
    const cloudModel = aiMod.getGenerativeModel(state.ai, {
      model: CLOUD_MODEL,
      generationConfig: cloudGenerationConfig
    });
    return { model: cloudModel, sourceOverride: "cloud" };
  }

  const model = aiMod.getGenerativeModel(state.ai, {
    mode,
    inCloudParams: {
      model: CLOUD_MODEL,
      generationConfig: cloudGenerationConfig
    },
    onDeviceParams: {
      promptOptions: { responseConstraint: schema }
    }
  });

  const wantsDevice = modeName !== "PREFER_IN_CLOUD" && modeName !== "ONLY_IN_CLOUD";
  if (wantsDevice && !state.deviceModelReady && typeof model.initializeDeviceModel === "function") {
    try {
      await model.initializeDeviceModel((val) => {
        onProgress && onProgress(Math.round(val * 100));
      });
    } catch (e) {
      // On-device model unavailable (unsupported platform or not yet
      // downloaded): PREFER_ON_DEVICE falls back to the cloud model
      // inside generateContent(); ONLY_ON_DEVICE surfaces its own
      // error there. Never let device init block the plan request.
    }
    state.deviceModelReady = true;
  }
  return { model, sourceOverride: null };
}

function extractSource(result) {
  // The SDK reports where inference ran when the platform exposes it;
  // check the known shapes defensively instead of guessing.
  const r = result && result.response;
  if (!r) return "unknown";
  if (r.inferenceSource) return String(r.inferenceSource).toLowerCase();
  if (r.candidates && r.candidates[0] && r.candidates[0].inferenceSource) {
    return String(r.candidates[0].inferenceSource).toLowerCase();
  }
  return "unknown";
}

/**
 * Ask the hybrid model for a rescue plan.
 * prompt: string from PantryEngine.buildRescuePrompt()
 * modeName: "PREFER_ON_DEVICE" | "ONLY_ON_DEVICE" | "PREFER_IN_CLOUD"
 * Returns { plan, source, latencyMs } — throws on model/SDK errors so
 * the UI can fall back to the local preview with an honest label.
 */
export async function planWithHybridAI(prompt, modeName, onProgress) {
  if (!state.configured) throw new Error("Firebase AI Logic is not configured.");
  const { model, sourceOverride } = await getHybridModel(modeName, onProgress);
  const t0 = performance.now();
  // The free-tier cloud model can return transient 5xx "high demand"
  // spikes (seen live 2026-11-15 on gemini-3.8-flash), hang without
  // answering at all (also seen live 2026-11-15, 9+ minutes), or simply
  // answer slowly: two live tests on 2026-11-15 died at a 45s deadline
  // while the model was still working. Bound every attempt with a
  // generous 150s timeout so a slow-but-alive call can finish, and
  // retry transient failures with backoff — but retry a timeout at
  // most once (two slow attempts is the ceiling, not three stacked
  // 150s waits) before the UI falls back to local preview.
  const ATTEMPT_TIMEOUT_MS = 150000;
  const withTimeout = (promise, ms) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Model call timed out after ${ms / 1000}s (deadline)`)),
          ms
        )
      ),
    ]);
  let result = null;
  let timeouts = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      result = await withTimeout(model.generateContent(prompt), ATTEMPT_TIMEOUT_MS);
      break;
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      const isTimeout = /timed out|deadline/i.test(msg);
      if (isTimeout) timeouts++;
      const transient =
        /\b(500|502|503|504)\b/.test(msg) ||
        /high demand|overloaded|try again later/i.test(msg) ||
        isTimeout;
      if (!transient || attempt === 2 || (isTimeout && timeouts > 1)) throw e;
      await new Promise((r) => setTimeout(r, attempt === 0 ? 2500 : 6000));
    }
  }
  const latencyMs = Math.round(performance.now() - t0);
  const text = result.response.text();
  let plan;
  try {
    plan = JSON.parse(text);
  } catch (e) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("Model did not return JSON.");
    plan = JSON.parse(text.slice(start, end + 1));
  }
  plan.source = "firebase-ai-logic";
  return { plan, source: sourceOverride || extractSource(result), latencyMs };
}

/** Check whether Chrome's on-device model is reachable at all. */
export async function onDeviceAvailability() {
  try {
    if (typeof LanguageModel === "undefined") return "unavailable";
    return await LanguageModel.availability();
  } catch (e) {
    return "unavailable";
  }
}

/* ---------------- Firestore pantry sync (optional) ---------------- */

export async function syncPantryToCloud(items) {
  if (!state.configured || !state.user) return { synced: false, reason: "not signed in" };
  const { fsMod } = state.mods;
  const db = fsMod.getFirestore(state.app);
  const ref = fsMod.doc(db, "pantries", state.user.uid);
  await fsMod.setDoc(ref, { items, updatedAt: Date.now() });
  return { synced: true };
}

export async function loadPantryFromCloud() {
  if (!state.configured || !state.user) return null;
  const { fsMod } = state.mods;
  const db = fsMod.getFirestore(state.app);
  const snap = await fsMod.getDoc(fsMod.doc(db, "pantries", state.user.uid));
  return snap.exists() ? snap.data().items : null;
}
