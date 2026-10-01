import { mergeDispatch } from "../src/dispatch/merge.ts";
import { BASE_TASKS, CAPACITIES, SEED_BATCHES } from "../src/dispatch/seed.ts";

const ops = SEED_BATCHES.flatMap((b) => b.ops);
const edits = SEED_BATCHES.flatMap((b) => b.taskEdits);

const r = mergeDispatch({ ops, taskEdits: edits, baseTasks: BASE_TASKS, capacities: CAPACITIES });

function assert(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!ok) process.exitCode = 1;
}

assert("stats.effective", r.stats.effective, 5);
assert("stats.queued", r.stats.queued, 2);
assert("stats.pendingReviews", r.stats.pendingReviews, 7);
assert("stats.cancelledGroups", r.stats.cancelledGroups, 1);
assert("stats.superseded", r.stats.superseded, 2);
assert("stats.disputedTasks", r.stats.disputedTasks, 1);
assert(
  "effective opIds",
  r.effective.map((o) => o.opId),
  ["OP-305", "OP-202", "OP-102", "OP-302", "OP-501"]
);
assert(
  "queued opIds",
  r.queued.map((q) => q.opId),
  ["OP-204", "OP-401"]
);
assert(
  "review reasons",
  r.reviews.map((x) => x.reason).sort(),
  [
    "driver-double",
    "stale-task",
    "task-conflict",
    "zone-overflow",
    "zone-overflow",
    "zone-unknown",
    "zone-unknown"
  ].sort()
);

const t104 = r.tasks.find((t) => t.taskId === "T-104")!;
assert("T-104 wins by issuedAt not upload order", [t104.title, t104.deviceId], ["生鲜急送(北线)", "调度台-01"]);
const t102 = r.tasks.find((t) => t.taskId === "T-102")!;
assert("T-102 zone edited to 城北", [t102.zone, t102.version], ["城北", 3]);
const t103 = r.tasks.find((t) => t.taskId === "T-103")!;
assert("T-103 disputed fallback base", [t103.disputed, t103.zone], [true, "城南"]);

// 顺序无关性：打乱批次/记录顺序后结果应一致（同一输入集合）
const shuffledOps = [...ops].reverse();
const r2 = mergeDispatch({ ops: shuffledOps, taskEdits: [...edits].reverse(), baseTasks: BASE_TASKS, capacities: CAPACITIES });
assert("order independent effective", r2.effective.map((o) => o.opId), r.effective.map((o) => o.opId));
assert("order independent reviews", r2.reviews.length, r.reviews.length);

// 人工放行超容：OP-204 确认后进入有效占用
const overflowReview = r.reviews.find((x) => x.reason === "zone-overflow" && x.opIds?.[0] === "OP-204")!;
const r3 = mergeDispatch(
  { ops, taskEdits: edits, baseTasks: BASE_TASKS, capacities: CAPACITIES },
  { resolutions: new Map([[overflowReview.id, { action: "confirm", at: "2026-10-01T10:00:00+08:00" }]]) }
);
assert("manual release effective", r3.stats.effective, 6);
assert("manual release flagged", r3.effective.find((o) => o.opId === "OP-204")?.manual, true);

// 同刻冲突裁定：采用 手持-02（城东）
const conflictReview = r.reviews.find((x) => x.reason === "task-conflict")!;
const editHand = conflictReview.editIds!.find((id) => id === "TE-2a")!;
const r4 = mergeDispatch(
  { ops, taskEdits: edits, baseTasks: BASE_TASKS, capacities: CAPACITIES },
  { resolutions: new Map([[conflictReview.id, { action: editHand, at: "2026-10-01T10:00:00+08:00" }]]) }
);
const t103b = r4.tasks.find((t) => t.taskId === "T-103")!;
assert("conflict adjudicated", [t103b.disputed, t103b.zone], [false, "城东"]);
// 裁定 T-103→城东 后，引用城南 v1 的 OP-302/OP-501 级联为 stale-task：待核对 7-1+2=8
assert("conflict adjudication cascades stale", r4.stats.pendingReviews, 8);
assert(
  "cascaded stale ops",
  r4.reviews.filter((x) => x.reason === "stale-task").map((x) => x.opIds?.[0]).sort(),
  ["OP-201", "OP-302", "OP-501"]
);
assert("effective after adjudication", r4.stats.effective, 3);

console.log("\neffective:", r.effective.map((o) => `${o.opId}(${o.vehicleId})`).join(", "));
console.log("reviews:", r.reviews.map((x) => `${x.reason}:${x.opIds?.[0] ?? x.taskId}`).join(", "));
