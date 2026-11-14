/*
 * PantryPilot — Firebase configuration (PLACEHOLDER)
 * ---------------------------------------------------
 * Fill this in with YOUR OWN Firebase web app config:
 *   Firebase console -> Project settings -> "Your apps" -> Web app.
 *
 * This file ships with placeholders on purpose. While the placeholders
 * are in place, PantryPilot runs in local mode: the deterministic
 * Rescue Engine works fully and the AI plan is a clearly-labelled
 * local preview. The moment a real config is pasted in, the same
 * "Plan my rescue" button starts using Firebase AI Logic hybrid
 * inference (on-device Gemini Nano in Chrome, cloud Gemini fallback).
 *
 * A web Firebase config is NOT a secret (it identifies the project;
 * access is controlled by Firebase Security Rules + App Check), but
 * per the hackathon rules you should still never commit production
 * keys of a real production project. This demo project is fine.
 */
window.PANTRYPILOT_FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
  // Optional: reCAPTCHA v3 site key for App Check in production.
  // Leave empty for the submission build — the App Check DEBUG token
  // flow is used instead (explicitly accepted by the hackathon rules).
  appCheckSiteKey: ""
};
