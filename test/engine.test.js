/* Unit tests for the PantryPilot deterministic engine.
 * Run: node --test test/
 * The engine file is the exact same file the browser loads. */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("../docs/engine.js");

const TODAY = new Date("2026-11-15T10:00:00");

function item(name, expiryDate, extra) {
  return Object.assign(
    { id: name, name, qty: 1, unit: "pcs", category: "produce", expiryDate, price: 0 },
    extra || {}
  );
}

function iso(daysFromToday) {
  const d = new Date(TODAY.getTime() + daysFromToday * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

test("daysLeft: today, future, past", () => {
  assert.equal(engine.daysLeft(item("a", iso(0)), TODAY), 0);
  assert.equal(engine.daysLeft(item("a", iso(3)), TODAY), 3);
  assert.equal(engine.daysLeft(item("a", iso(-2)), TODAY), -2);
});

test("riskScore: expired is max, far future is low, monotonic in between", () => {
  const expired = engine.riskScore(item("a", iso(-1)), TODAY);
  const today = engine.riskScore(item("a", iso(0)), TODAY);
  const soon = engine.riskScore(item("a", iso(3)), TODAY);
  const far = engine.riskScore(item("a", iso(30)), TODAY);
  assert.equal(expired, 100);
  assert.ok(today > soon && soon > far, `expected ${today} > ${soon} > ${far}`);
  assert.ok(far <= 12);
});

test("riskScore: perishable categories score >= pantry staples at same date", () => {
  const seafood = engine.riskScore(item("a", iso(2), { category: "seafood" }), TODAY);
  const pantry = engine.riskScore(item("a", iso(2), { category: "pantry" }), TODAY);
  assert.ok(seafood >= pantry);
});

test("riskLevel bands", () => {
  assert.equal(engine.riskLevel(item("a", iso(-1)), TODAY), "critical");
  assert.equal(engine.riskLevel(item("a", iso(2)), TODAY), "critical");
  assert.equal(engine.riskLevel(item("a", iso(4)), TODAY), "soon");
  assert.equal(engine.riskLevel(item("a", iso(9)), TODAY), "ok");
});

test("rescueQueue: filters by threshold and sorts most urgent first", () => {
  const items = [
    item("rice", iso(60), { category: "pantry" }),
    item("milk", iso(1), { category: "dairy" }),
    item("spinach", iso(0)),
    item("eggs", iso(6), { category: "dairy" })
  ];
  const q = engine.rescueQueue(items, TODAY, 7);
  assert.deepEqual(q.map((e) => e.item.name), ["spinach", "milk", "eggs"]);
  assert.equal(engine.rescueQueue(items, TODAY, 0).length, 1);
});

test("moneyAtRisk sums prices inside the queue only", () => {
  const items = [
    item("chicken", iso(1), { category: "meat", price: 45000 }),
    item("rice", iso(90), { category: "pantry", price: 65000 }),
    item("milk", iso(2), { category: "dairy", price: 22000 })
  ];
  assert.equal(engine.moneyAtRisk(items, TODAY, 7), 67000);
  assert.equal(engine.formatIDR(67000), "Rp67.000");
  assert.equal(engine.formatIDR(1500000), "Rp1.500.000");
});

test("buildRescuePrompt lists items with urgency wording", () => {
  const items = [item("milk", iso(0), { category: "dairy", qty: 1, unit: "L" }),
                 item("yogurt", iso(-1), { category: "dairy" })];
  const q = engine.rescueQueue(items, TODAY, 7);
  const prompt = engine.buildRescuePrompt(q);
  assert.match(prompt, /milk/);
  assert.match(prompt, /expires TODAY/);
  assert.match(prompt, /EXPIRED/);
  assert.match(prompt, /JSON only/);
});

test("localPreviewPlan: uses urgent items, excludes expired, labels itself", () => {
  const items = [
    item("chicken breast", iso(1), { category: "meat" }),
    item("bell pepper", iso(2)),
    item("old yogurt", iso(-3), { category: "dairy" })
  ];
  const q = engine.rescueQueue(items, TODAY, 7);
  const plan = engine.localPreviewPlan(q);
  assert.ok(plan.usesItems.includes("chicken breast"));
  assert.ok(!plan.usesItems.includes("old yogurt"));
  assert.match(plan.summary, /Local preview plan/);
  assert.equal(plan.source, "local-preview");
  assert.ok(plan.steps.length >= 3);
});

test("localPreviewPlan: empty queue is graceful", () => {
  const plan = engine.localPreviewPlan([]);
  assert.equal(plan.title, "Nothing to rescue yet");
  assert.deepEqual(plan.usesItems, []);
});
