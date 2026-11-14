/*
 * PantryPilot — Deterministic Rescue Engine
 * -----------------------------------------
 * Pure, dependency-free logic that powers PantryPilot with zero AI:
 * expiry math, per-item risk scoring, the rescue queue, money-at-risk
 * estimates, the shared AI prompt builder, and a local preview plan.
 *
 * This engine is the app's honest floor: it works offline, in any
 * browser, with no Firebase project and no network. The hybrid AI
 * layer (hybrid-ai.js) builds on top of it — it never replaces it.
 *
 * Works in the browser (window.PantryEngine) and in Node (require),
 * so the exact code that ships is the code that is unit-tested.
 */
(function (global) {
  "use strict";

  // Perishability weight per category: how fast quality collapses once
  // the expiry date passes. 1.0 = average, >1 = collapses faster.
  var CATEGORY_WEIGHT = {
    dairy: 1.15,
    meat: 1.2,
    seafood: 1.25,
    produce: 1.1,
    bakery: 1.0,
    cooked: 1.2,
    pantry: 0.8,
    frozen: 0.7,
    drink: 0.9,
    other: 1.0
  };

  var MS_PER_DAY = 24 * 60 * 60 * 1000;

  function startOfDay(d) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return x.getTime();
  }

  /** Whole days from `today` until the item's expiry date. Negative = expired. */
  function daysLeft(item, today) {
    var t = today ? new Date(today) : new Date();
    var exp = new Date(item.expiryDate + "T00:00:00");
    return Math.round((startOfDay(exp) - startOfDay(t)) / MS_PER_DAY);
  }

  /**
   * Risk score 0..100. Driven by days left, nudged by category
   * perishability and (slightly) by quantity — a big pack of chicken
   * expiring tomorrow is a bigger loss than one egg.
   */
  function riskScore(item, today) {
    var d = daysLeft(item, today);
    var base;
    if (d < 0) base = 100;          // already expired
    else if (d === 0) base = 96;    // expires today
    else if (d === 1) base = 88;
    else if (d === 2) base = 76;
    else if (d === 3) base = 63;
    else if (d === 4) base = 52;
    else if (d === 5) base = 43;
    else if (d === 7) base = 30;
    else if (d <= 10) base = 20;
    else if (d <= 14) base = 12;
    else base = Math.max(2, 12 - (d - 14) * 0.2);

    var w = CATEGORY_WEIGHT[item.category] || 1.0;
    var qtyBoost = Math.min(6, Math.max(0, (Number(item.qty) || 1) - 1) * 1.5);
    var score = base * (0.92 + 0.08 * w) + (base > 40 ? qtyBoost : 0);
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /** critical: expires in <=2 days or expired · soon: <=5 days · ok: later */
  function riskLevel(item, today) {
    var d = daysLeft(item, today);
    if (d <= 2) return "critical";
    if (d <= 5) return "soon";
    return "ok";
  }

  /**
   * The rescue queue: items that need attention within `thresholdDays`,
   * most urgent first (risk desc, then earliest expiry).
   */
  function rescueQueue(items, today, thresholdDays) {
    var limit = typeof thresholdDays === "number" ? thresholdDays : 7;
    return items
      .filter(function (it) { return daysLeft(it, today) <= limit; })
      .map(function (it) {
        return {
          item: it,
          daysLeft: daysLeft(it, today),
          score: riskScore(it, today),
          level: riskLevel(it, today)
        };
      })
      .sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        return a.daysLeft - b.daysLeft;
      });
  }

  /** Sum of the estimated prices of items in the rescue queue. */
  function moneyAtRisk(items, today, thresholdDays) {
    return rescueQueue(items, today, thresholdDays).reduce(function (sum, e) {
      return sum + (Number(e.item.price) || 0);
    }, 0);
  }

  function formatIDR(n) {
    return "Rp" + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }

  /**
   * The exact prompt sent to the hybrid model. Built here (not in the
   * AI layer) so it is testable and identical for on-device and cloud.
   */
  function buildRescuePrompt(queueEntries) {
    var lines = queueEntries.map(function (e) {
      var it = e.item;
      var when = e.daysLeft < 0
        ? "EXPIRED " + Math.abs(e.daysLeft) + " day(s) ago — only include if it is a shelf-stable item that is still safe, otherwise tell me to discard it"
        : e.daysLeft === 0 ? "expires TODAY" : "expires in " + e.daysLeft + " day(s)";
      return "- " + it.name + " (" + it.qty + " " + (it.unit || "pcs") + ", " + it.category + ") — " + when;
    });
    return [
      "You are a home cook helping me waste less food. These ingredients in my kitchen need rescuing, most urgent first:",
      lines.join("\n"),
      "",
      "Create ONE practical dinner plan for 2 people that uses as many of the urgent items as possible.",
      "Prefer simple techniques (one pan, one pot, oven tray). Do not invent ingredients I did not list,",
      "except basic staples (oil, salt, pepper, garlic, onion, rice, flour). If an item is expired and not",
      "shelf-stable, exclude it from the meal and mention discarding it in the summary.",
      "Respond with JSON only, matching the provided schema."
    ].join("\n");
  }

  /**
   * Local preview plan — deterministic, no AI. Used when Firebase is
   * not configured or the model is unreachable, and ALWAYS labelled
   * in the UI as a local preview (never presented as model output).
   */
  function localPreviewPlan(queueEntries) {
    var usable = queueEntries.filter(function (e) { return e.daysLeft >= 0; });
    var expired = queueEntries.filter(function (e) { return e.daysLeft < 0; });
    var names = usable.map(function (e) { return e.item.name; });
    var cats = {};
    usable.forEach(function (e) { cats[e.item.category] = true; });

    var title, steps;
    if (names.length === 0) {
      title = "Nothing to rescue yet";
      steps = ["Your rescue queue is empty or everything in it has expired.",
               "Add items with expiry dates and PantryPilot will keep watch."];
    } else if (cats.meat || cats.seafood || cats.produce) {
      title = "One-pan rescue stir-fry: " + names.slice(0, 3).join(", ") + (names.length > 3 ? " & more" : "");
      steps = [
        "Heat oil in your largest pan or wok on high heat.",
        "Cook the protein first (" + names.filter(function (n, i) { return usable[i].item.category === "meat" || usable[i].item.category === "seafood"; }).join(", ") + ") until done; set aside.",
        "Stir-fry the remaining vegetables and aromatics in the same pan, hardest first.",
        "Return the protein, season with salt, pepper and garlic, toss for 1 minute.",
        "Serve over rice or noodles. Eat tonight — these items were the most urgent in your kitchen."
      ].filter(function (s) { return s.indexOf("()") === -1; });
    } else if (cats.dairy || cats.bakery) {
      title = "Rescue bake & toast plate: " + names.slice(0, 3).join(", ");
      steps = [
        "Preheat the oven to 180°C.",
        "Turn bread/bakery items into garlic toast or croutons.",
        "Use dairy items in a quick sauce or bake before they turn.",
        "Serve warm tonight; freeze anything baked that is left over."
      ];
    } else {
      title = "Clean-out-the-pantry soup pot: " + names.slice(0, 3).join(", ");
      steps = [
        "Bring a pot of salted water or stock to a boil.",
        "Add the longest-cooking items first, softest items last.",
        "Simmer 15–20 minutes, season, and serve hot.",
        "Portion and freeze leftovers so nothing rescued goes to waste twice."
      ];
    }

    var summary = "Local preview plan (deterministic, generated on this device without an AI model). " +
      "It uses " + usable.length + " of " + queueEntries.length + " queued item(s)." +
      (expired.length ? " " + expired.length + " expired item(s) were excluded — check before eating, discard if in doubt." : "");

    return {
      title: title,
      summary: summary,
      steps: steps,
      usesItems: names,
      missingItems: [],
      timeMinutes: 25,
      servings: 2,
      source: "local-preview"
    };
  }

  var api = {
    CATEGORY_WEIGHT: CATEGORY_WEIGHT,
    daysLeft: daysLeft,
    riskScore: riskScore,
    riskLevel: riskLevel,
    rescueQueue: rescueQueue,
    moneyAtRisk: moneyAtRisk,
    formatIDR: formatIDR,
    buildRescuePrompt: buildRescuePrompt,
    localPreviewPlan: localPreviewPlan
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.PantryEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
