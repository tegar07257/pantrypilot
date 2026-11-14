/*
 * PantryPilot — UI glue.
 * State lives in localStorage. The deterministic engine (engine.js)
 * drives every number on screen. The hybrid AI layer (hybrid-ai.js)
 * is loaded lazily on first use; if Firebase is not configured or the
 * model call fails, the plan falls back to the engine's local preview
 * and says so, in the badge, in plain sight.
 */
(function () {
  "use strict";
  var E = window.PantryEngine;
  var LS_ITEMS = "pantrypilot.items.v1";
  var LS_SHOP = "pantrypilot.shop.v1";

  var items = load(LS_ITEMS, null);
  var shop = load(LS_SHOP, []);
  var hybrid = null;          // loaded hybrid-ai module
  var hybridReady = false;    // Firebase configured?
  var lastPlan = null;
  var thresholdDays = 7;      // Remote Config can override once hybrid is live

  if (!items) { items = seedItems(); save(LS_ITEMS, items); }

  function load(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }

  function isoIn(days) {
    var d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  }
  function seedItems() {
    // Demo pantry with dates relative to today, so the demo always
    // shows a living rescue queue. Users replace it with their own.
    return [
      { id: "s1", name: "Baby spinach", qty: 1, unit: "pack", category: "produce", expiryDate: isoIn(0), price: 18000 },
      { id: "s2", name: "Fresh milk", qty: 1, unit: "L", category: "dairy", expiryDate: isoIn(1), price: 22000 },
      { id: "s3", name: "Chicken breast", qty: 500, unit: "g", category: "meat", expiryDate: isoIn(2), price: 45000 },
      { id: "s4", name: "Greek yogurt", qty: 2, unit: "cup", category: "dairy", expiryDate: isoIn(-1), price: 30000 },
      { id: "s5", name: "Eggs", qty: 10, unit: "pcs", category: "dairy", expiryDate: isoIn(4), price: 28000 },
      { id: "s6", name: "Bell peppers", qty: 3, unit: "pcs", category: "produce", expiryDate: isoIn(3), price: 15000 },
      { id: "s7", name: "Rice", qty: 2, unit: "kg", category: "pantry", expiryDate: isoIn(90), price: 65000 },
      { id: "s8", name: "Sourdough loaf", qty: 1, unit: "pcs", category: "bakery", expiryDate: isoIn(2), price: 35000 }
    ];
  }

  var $ = function (id) { return document.getElementById(id); };

  function render() {
    var today = new Date();
    var queue = E.rescueQueue(items, today, thresholdDays);

    $("statItems").textContent = items.length;
    $("statRisk").textContent = queue.length;
    $("statMoney").textContent = E.formatIDR(E.moneyAtRisk(items, today, thresholdDays));
    $("queueHint").textContent = "(next " + thresholdDays + " days)";

    // Inventory
    var inv = $("inventoryList");
    inv.innerHTML = "";
    items.slice().sort(function (a, b) { return E.daysLeft(a, today) - E.daysLeft(b, today); })
      .forEach(function (it) {
        var d = E.daysLeft(it, today);
        var level = E.riskLevel(it, today);
        var li = document.createElement("li");
        li.innerHTML =
          '<div class="item-main"><span class="item-name"></span>' +
          '<div class="item-sub"></div></div>' +
          '<span class="badge badge-' + level + '">' +
          (d < 0 ? "expired " + Math.abs(d) + "d ago" : d === 0 ? "expires today" : d + "d left") +
          "</span>" +
          '<button class="btn btn-small" title="Mark as used">✓ Used</button>';
        li.querySelector(".item-name").textContent = it.name;
        li.querySelector(".item-sub").textContent =
          it.qty + " " + it.unit + " · " + it.category + (it.price ? " · " + E.formatIDR(it.price) : "");
        li.querySelector("button").addEventListener("click", function () {
          items = items.filter(function (x) { return x.id !== it.id; });
          save(LS_ITEMS, items); render();
        });
        inv.appendChild(li);
      });

    // Rescue queue
    var ql = $("queueList");
    ql.innerHTML = "";
    $("queueEmpty").hidden = queue.length > 0;
    queue.forEach(function (e) {
      var li = document.createElement("li");
      li.innerHTML =
        '<div class="item-main"><span class="item-name"></span>' +
        '<div class="item-sub"></div>' +
        '<div class="riskbar"><div style="width:' + e.score + '%"></div></div></div>' +
        '<span class="badge badge-' + e.level + '">risk ' + e.score + "</span>";
      li.querySelector(".item-name").textContent = e.item.name;
      li.querySelector(".item-sub").textContent =
        e.daysLeft < 0 ? "expired " + Math.abs(e.daysLeft) + " day(s) ago"
        : e.daysLeft === 0 ? "expires today" : "expires in " + e.daysLeft + " day(s)";
      ql.appendChild(li);
    });

    // Shopping list
    var sl = $("shopList");
    sl.innerHTML = "";
    $("shopEmpty").style.display = shop.length ? "none" : "";
    shop.forEach(function (name, i) {
      var li = document.createElement("li");
      li.innerHTML = '<span class="item-name"></span><button class="btn btn-small">✓ Bought</button>';
      li.querySelector(".item-name").textContent = name;
      li.querySelector("button").addEventListener("click", function () {
        shop.splice(i, 1); save(LS_SHOP, shop); render();
      });
      sl.appendChild(li);
    });
  }

  // ---------- Hybrid AI bootstrap (lazy, honest) ----------
  async function ensureHybrid() {
    if (hybrid) return hybrid;
    hybrid = await import("./hybrid-ai.js");
    var res = await hybrid.initHybridAI(function (msg) { setProgress(msg); });
    hybridReady = !!res.configured;
    if (hybridReady) {
      var pill = $("engineStatus");
      pill.textContent = "Hybrid live: Firebase AI Logic";
      pill.className = "pill pill-live";
      var rc = hybrid.getRemoteConfig();
      if (rc && rc.rescueThresholdDays) { thresholdDays = rc.rescueThresholdDays; render(); }
      $("syncBtn").disabled = false;
      $("syncNote").textContent = "Signed in anonymously — sync stores this pantry in Firestore under your anonymous account.";
    }
    return hybrid;
  }

  function setProgress(msg) {
    var p = $("planProgress");
    if (!msg) { p.hidden = true; p.textContent = ""; return; }
    p.hidden = false; p.textContent = msg;
  }

  async function checkDevice() {
    var pill = $("deviceStatus");
    try {
      if (typeof LanguageModel === "undefined") {
        pill.textContent = "On-device model: not in this browser";
        return;
      }
      var a = await LanguageModel.availability();
      pill.textContent = "On-device model (Gemini Nano): " + a;
      if (a === "available") pill.className = "pill pill-device";
    } catch (e) {
      pill.textContent = "On-device model: unavailable";
    }
  }

  // ---------- Planning ----------
  function showPlan(plan, badgeText, badgeClass, latencyText) {
    lastPlan = plan;
    $("planResult").hidden = false;
    var src = $("planSource");
    src.textContent = badgeText;
    src.className = "pill " + badgeClass;
    $("planLatency").textContent = latencyText || "";
    $("planTitle").textContent = plan.title || "Rescue plan";
    $("planSummary").textContent = plan.summary || "";
    var ol = $("planSteps");
    ol.innerHTML = "";
    (plan.steps || []).forEach(function (s) {
      var li = document.createElement("li");
      li.textContent = s;
      ol.appendChild(li);
    });
    $("planUses").textContent = (plan.usesItems || []).join(", ") || "—";
    $("planMissing").textContent = (plan.missingItems || []).join(", ") || "nothing";
    $("addMissingBtn").hidden = !(plan.missingItems && plan.missingItems.length);
  }

  async function onPlan() {
    var today = new Date();
    var queue = E.rescueQueue(items, today, thresholdDays);
    if (!queue.length) {
      showPlan(E.localPreviewPlan(queue), "Local preview — nothing to rescue", "pill-preview", "");
      return;
    }
    var mode = document.querySelector('input[name="mode"]:checked').value;
    var btn = $("planBtn");
    btn.disabled = true;
    setProgress("Asking the hybrid model (" + mode.replace(/_/g, " ").toLowerCase() + ")…");
    try {
      var h = await ensureHybrid();
      if (!hybridReady) throw new Error("local-mode");
      var prompt = E.buildRescuePrompt(queue);
      var out = await h.planWithHybridAI(prompt, mode, function (pct) {
        setProgress("Downloading on-device model… " + pct + "%");
      });
      setProgress("");
      var badge = out.source.indexOf("device") !== -1
        ? "Served ON-DEVICE · Gemini Nano" : out.source.indexOf("cloud") !== -1
        ? "Served in CLOUD · Gemini" : "Served by Firebase AI Logic hybrid routing";
      showPlan(out.plan, badge, out.source.indexOf("device") !== -1 ? "pill-device" : "pill-cloud",
               "answered in " + out.latencyMs + " ms · mode " + mode);
    } catch (err) {
      setProgress("");
      var plan = E.localPreviewPlan(queue);
      var why = err && err.message === "local-mode"
        ? "Local preview — add a Firebase config to go hybrid"
        : "Local preview — model unavailable (" + (err && err.message ? err.message : err) + ")";
      showPlan(plan, why, "pill-preview", "generated on this device, no network");
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- Events ----------
  $("addForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var it = {
      id: "i" + Date.now(),
      name: $("fName").value.trim(),
      qty: Number($("fQty").value) || 1,
      unit: $("fUnit").value.trim() || "pcs",
      category: $("fCategory").value,
      price: Number($("fPrice").value) || 0,
      expiryDate: $("fExpiry").value
    };
    if (!it.name || !it.expiryDate) return;
    items.push(it);
    save(LS_ITEMS, items);
    ev.target.reset();
    $("fQty").value = 1; $("fUnit").value = "pcs";
    render();
  });

  $("planBtn").addEventListener("click", onPlan);

  $("addMissingBtn").addEventListener("click", function () {
    if (!lastPlan) return;
    (lastPlan.missingItems || []).forEach(function (m) {
      if (shop.indexOf(m) === -1) shop.push(m);
    });
    save(LS_SHOP, shop); render();
  });

  $("syncBtn").addEventListener("click", async function () {
    try {
      var h = await ensureHybrid();
      var r = await h.syncPantryToCloud(items);
      $("syncNote").textContent = r.synced ? "Synced to Firestore ✓" : "Sync unavailable: " + r.reason;
    } catch (e) {
      $("syncNote").textContent = "Sync failed: " + e.message;
    }
  });

  // Default the date input to tomorrow for convenience.
  $("fExpiry").value = isoIn(1);

  render();
  checkDevice();
  // Warm up the hybrid layer in the background so the status pill is
  // truthful; failures are silent here (local mode is a valid mode).
  ensureHybrid().catch(function () {});
})();
