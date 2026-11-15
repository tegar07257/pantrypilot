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
 *   - App Check (debug-token flow for the submission build — the
 *     hackathon rules explicitly accept debug tokens; a reCAPTCHA v3
 *     provider is used automatically when a site key is configured)
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
  // Submission build: debug token flow (accepted by the hackathon
  // rules). The debug token printed in the browser console must be
  // registered once in Firebase console > App Check > Manage debug
  // tokens. With a real reCAPTCHA site key we use the real provider.
  try {
    if (cfg.appCheckSiteKey) {
      appCheckMod.initializeAppCheck(state.app, {
        provider: new appCheckMod.ReCaptchaV3Provider(cfg.appCheckSiteKey),
        isTokenAutoRefreshEnabled: true
      });
    } else {
      self.FIREBASE_APPCHECK_DEBUG_TOKEN = "fcc1ce5b-27d4-4444-8560-97ef78e04ddf";
      appCheckMod.initializeAppCheck(state.app, {
        provider: new appCheckMod.ReCaptchaV3Provider("pantrypilot-debug-placeholder"),
        isTokenAutoRefreshEnabled: true
      });
      onStatus && onStatus("App Check: fixed debug token mode (token in code, registered in Firebase console for this demo project).");
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
async function getHybridModel(modeName, onProgress) {
  const { aiMod } = state.mods;
  const { InferenceMode } = aiMod;
  const mode = InferenceMode[modeName] || InferenceMode.PREFER_ON_DEVICE;
  const schema = planSchema(aiMod.Schema);

  const model = aiMod.getGenerativeModel(state.ai, {
    mode,
    inCloudParams: {
      model: "gemini-2.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: schema,
        temperature: 0.6,
        maxOutputTokens: 1024
      }
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
  return model;
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
  const model = await getHybridModel(modeName, onProgress);
  const t0 = performance.now();
  const result = await model.generateContent(prompt);
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
  return { plan, source: extractSource(result), latencyMs };
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
