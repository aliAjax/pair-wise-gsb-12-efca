import test from "node:test";
import assert from "node:assert/strict";
import { mergeDispatch } from "../src/merge/offlineMerge";
import { buildDemoBatches } from "../src/merge/demoData";
import type { DispatchOp, OutboxBatch, ZoneConfig } from "../src/types";

const SHIFT = "2026-10-01/早班";
const zones: ZoneConfig[] = [
  { zone: "城北", capacity: 2, queueLimit: 1 },
  { zone: "城东", capacity: 1, queueLimit: 1 },
  { zone: "城南", capacity: 1, queueLimit: 0 }
];

let seq = 0;
function makeOp(partial: Partial<DispatchOp> & Pick<DispatchOp, "vehicle" | "driver" | "zone" | "taskId">): DispatchOp {
  seq += 1;
  const t = 1_759_200_000_000 + seq * 60_000;
  return {
    id: `op-${seq}`,
    batchId: "b1",
    deviceId: "dev-A",
    issuedAt: t,
    uploadedAt: t + 3_600_000,
    shift: SHIFT,
    taskTitle: partial.taskId ?? "任务",
    taskVersion: 1,
    type: "assign",
    ...partial
  };
}

function batch(deviceId: string, ops: DispatchOp[], id = `batch-${deviceId}`): OutboxBatch {
  return { id, deviceId, createdAt: Date.now(), ops, retryCount: 0 };
}

function statusOf(result: ReturnType<typeof mergeDispatch>, opId: string) {
  return result.items.find((item) => item.opId === opId)?.status;
}

function itemOf(result: ReturnType<typeof mergeDispatch>, opId: string) {
  return result.items.find((item) => item.opId === opId);
}

test("同一车辆同一班次只留一条有效占用，按发起时刻而非上传顺序", () => {
  // op-later 发起更晚，但故意先上传（uploadedAt 更小）
  const opLater = makeOp({
    id: "late",
    vehicle: "沪A-1",
    driver: "董飞",
    zone: "城北",
    taskId: "T1",
    issuedAt: 1_759_200_600_000,
    uploadedAt: 1_759_203_000_000
  });
  const opEarlier = makeOp({
    id: "early",
    vehicle: "沪A-1",
    driver: "周航",
    zone: "城北",
    taskId: "T2",
    issuedAt: 1_759_200_300_000,
    uploadedAt: 1_759_207_200_000 // 更晚上传
  });

  const result = mergeDispatch({
    committed: [],
    batches: [batch("dev-A", [opEarlier, opLater])],
    zones
  });

  assert.equal(statusOf(result, "late"), "accepted");
  assert.equal(statusOf(result, "early"), "superseded");
  const occ = result.vehicleOccupancy.find((o) => o.vehicle === "沪A-1");
  assert.equal(occ?.driver, "董飞");
});

test("同车同班次同刻同内容为重复派车，去重保留一条", () => {
  const a = makeOp({
    id: "dup-1",
    batchId: "b1",
    deviceId: "dev-A",
    vehicle: "沪B-1",
    driver: "司机甲",
    zone: "城北",
    taskId: "T9",
    issuedAt: 1_759_200_600_000,
    uploadedAt: 1_759_203_600_000
  });
  const b = makeOp({
    ...a,
    id: "dup-2",
    batchId: "b2",
    deviceId: "dev-B",
    uploadedAt: 1_759_207_200_000
  });
  const result = mergeDispatch({ committed: [], batches: [batch("dev-A", [a]), batch("dev-B", [b])], zones });
  assert.equal(statusOf(result, "dup-1"), "accepted");
  assert.equal(statusOf(result, "dup-2"), "superseded");
});

test("同车同班次同刻但内容不同，先后无法判定，双方待核对", () => {
  const a = makeOp({
    id: "tie-a",
    vehicle: "沪C-1",
    driver: "甲",
    zone: "城北",
    taskId: "T10",
    issuedAt: 1_759_200_600_000,
    uploadedAt: 1_759_203_600_000
  });
  const b = makeOp({
    id: "tie-b",
    vehicle: "沪C-1",
    driver: "乙",
    zone: "城北",
    taskId: "T11",
    issuedAt: 1_759_200_600_000,
    uploadedAt: 1_759_207_200_000
  });
  const result = mergeDispatch({ committed: [], batches: [batch("dev-A", [a, b])], zones });
  assert.equal(statusOf(result, "tie-a"), "review");
  assert.equal(statusOf(result, "tie-b"), "review");
});

test("多设备编辑同一任务：发起时刻新的版本有效，无视上传顺序", () => {
  const assign = makeOp({
    id: "base",
    vehicle: "沪D-1",
    driver: "甲",
    zone: "城东",
    taskId: "T20",
    taskTitle: "医药配送-老版本",
    taskVersion: 1,
    issuedAt: 1_759_200_000_000
  });
  // dev-B 的编辑发起更晚，但先上传
  const editB = makeOp({
    id: "edit-b",
    deviceId: "dev-B",
    vehicle: "",
    driver: "",
    zone: "城东",
    taskId: "T20",
    taskTitle: "医药配送-改目的地",
    taskVersion: 2,
    type: "editTask",
    issuedAt: 1_759_200_900_000,
    uploadedAt: 1_759_203_600_000
  });
  const editA = makeOp({
    id: "edit-a",
    deviceId: "dev-A",
    vehicle: "",
    driver: "",
    zone: "城东",
    taskId: "T20",
    taskTitle: "医药配送-改时间",
    taskVersion: 2,
    type: "editTask",
    issuedAt: 1_759_200_300_000,
    uploadedAt: 1_759_207_200_000 // 更晚上传仍应判负
  });
  const result = mergeDispatch({
    committed: [],
    batches: [batch("dev-A", [assign, editA]), batch("dev-B", [editB])],
    zones
  });
  assert.equal(statusOf(result, "edit-b"), "accepted");
  assert.equal(statusOf(result, "edit-a"), "superseded");
  // 派车记录展示任务的有效标题
  assert.equal(itemOf(result, "base")?.effectiveTaskTitle, "医药配送-改目的地");
});

test("同刻同版本但编辑内容不一致：无法判定，双方待核对", () => {
  const a = makeOp({
    id: "conflict-a",
    deviceId: "dev-A",
    vehicle: "",
    driver: "",
    zone: "城东",
    taskId: "T30",
    taskTitle: "改成城北",
    taskVersion: 3,
    type: "editTask",
    issuedAt: 1_759_200_600_000,
    uploadedAt: 1_759_203_600_000
  });
  const b = makeOp({
    id: "conflict-b",
    deviceId: "dev-B",
    vehicle: "",
    driver: "",
    zone: "城东",
    taskId: "T30",
    taskTitle: "改成城南",
    taskVersion: 3,
    type: "editTask",
    issuedAt: 1_759_200_600_000,
    uploadedAt: 1_759_207_200_000
  });
  const result = mergeDispatch({ committed: [], batches: [batch("dev-A", [a]), batch("dev-B", [b])], zones });
  assert.equal(statusOf(result, "conflict-a"), "review");
  assert.equal(statusOf(result, "conflict-b"), "review");
});

test("区域容量：容量内有效、其后排队、超出排队上限待核对，按发起时刻先后", () => {
  const ops = ["城北-v1", "城北-v2", "城北-v3", "城北-v4"].map((vehicle, i) =>
    makeOp({
      id: `z-${i}`,
      vehicle,
      driver: `司机${i}`,
      zone: "城北",
      taskId: `Z${i}`,
      issuedAt: 1_759_200_000_000 + i * 60_000
    })
  );
  // 打乱上传顺序，证明队列按发起时刻
  ops[3].uploadedAt = ops[0].uploadedAt;
  const result = mergeDispatch({ committed: [], batches: [batch("dev-A", ops)], zones });
  assert.equal(statusOf(result, "z-0"), "accepted");
  assert.equal(statusOf(result, "z-1"), "accepted");
  assert.equal(statusOf(result, "z-2"), "queued");
  assert.equal(statusOf(result, "z-3"), "review");
  const stat = result.zones.find((z) => z.zone === "城北")!;
  assert.deepEqual(
    { active: stat.active, queued: stat.queued, review: stat.review },
    { active: 2, queued: 1, review: 1 }
  );
});

test("排队上限为 0 的区域溢出即待核对", () => {
  const a = makeOp({ id: "s-1", vehicle: "v1", driver: "d1", zone: "城南", taskId: "S1", issuedAt: 1000 });
  const b = makeOp({ id: "s-2", vehicle: "v2", driver: "d2", zone: "城南", taskId: "S2", issuedAt: 2000 });
  const result = mergeDispatch({ committed: [], batches: [batch("dev-A", [a, b])], zones });
  assert.equal(statusOf(result, "s-1"), "accepted");
  assert.equal(statusOf(result, "s-2"), "review");
});

test("同一司机同一班次被两辆车占用：双方待核对", () => {
  const a = makeOp({ id: "drv-a", vehicle: "沪E-1", driver: "王师傅", zone: "城北", taskId: "D1", issuedAt: 1000 });
  const b = makeOp({ id: "drv-b", vehicle: "沪E-2", driver: "王师傅", zone: "城东", taskId: "D2", issuedAt: 2000 });
  const result = mergeDispatch({ committed: [], batches: [batch("dev-A", [a, b])], zones });
  assert.equal(statusOf(result, "drv-a"), "review");
  assert.equal(statusOf(result, "drv-b"), "review");
});

test("司机冲突经人工强制确认后，重算时该占用生效（容量规则仍执行）", () => {
  const a = makeOp({ id: "drv2-a", vehicle: "沪F-1", driver: "赵师傅", zone: "城北", taskId: "D3", issuedAt: 1000 });
  const b = makeOp({ id: "drv2-b", vehicle: "沪F-2", driver: "赵师傅", zone: "城北", taskId: "D4", issuedAt: 2000 });
  const first = mergeDispatch({ committed: [], batches: [batch("dev-A", [a, b])], zones });
  assert.equal(statusOf(first, "drv2-b"), "review");

  const resolved = { ...b, forceAccepted: true, resolveNote: "电话核实，实际驾驶沪F-2" };
  const second = mergeDispatch({ committed: [], batches: [batch("dev-A", [a, resolved])], zones });
  assert.equal(statusOf(second, "drv2-b"), "accepted");
  assert.equal(statusOf(second, "drv2-a"), "review");
});

test("写入失败重试：同一批次带相同幂等键再次合并，记录只计一次", () => {
  const op = makeOp({ id: "once", vehicle: "沪G-1", driver: "钱师傅", zone: "城东", taskId: "O1", issuedAt: 1000 });
  const first = mergeDispatch({ committed: [], batches: [batch("dev-A", [op], "b-retry")], zones });
  assert.equal(first.summary.accepted, 1);

  const retry = mergeDispatch({
    committed: [],
    batches: [{ ...batch("dev-A", [op], "b-retry"), retryCount: 2 }],
    zones
  });
  assert.equal(retry.items.filter((item) => item.opId === "once").length, 1);
});

test("已确认记录与重试批次同 id：幂等去重，不重复占用容量", () => {
  const op = makeOp({ id: "committed-1", vehicle: "沪H-1", driver: "孙师傅", zone: "城东", taskId: "C1", issuedAt: 1000 });
  const result = mergeDispatch({
    committed: [op],
    batches: [batch("dev-A", [op])],
    zones
  });
  const entries = result.items.filter((item) => item.opId === "committed-1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].committed, true);
  assert.equal(entries[0].status, "accepted");
});

test("重试批次同 id 但内容与已确认不一致：待核对，且不覆盖已确认占用", () => {
  const op = makeOp({ id: "committed-2", vehicle: "沪H-2", driver: "孙师傅", zone: "城东", taskId: "C2", issuedAt: 1000 });
  const stale = makeOp({ id: "committed-2", vehicle: "沪H-9", driver: "李四", zone: "城东", taskId: "C9", issuedAt: 1000 });
  const result = mergeDispatch({
    committed: [op],
    batches: [batch("dev-A", [stale])],
    zones
  });
  const entries = result.items.filter((item) => item.opId === "committed-2");
  assert.equal(entries.length, 2);
  assert.ok(entries.some((item) => item.committed && item.status === "accepted"));
  assert.ok(entries.some((item) => !item.committed && item.status === "review"));
});

test("同 id 记录在两个批次内容不一致：双方待核对", () => {
  const a = makeOp({ id: "same", vehicle: "沪I-1", driver: "甲", zone: "城北", taskId: "K1", issuedAt: 1000 });
  const b = makeOp({ id: "same", vehicle: "沪I-2", driver: "乙", zone: "城北", taskId: "K2", issuedAt: 1000 });
  const result = mergeDispatch({ committed: [], batches: [batch("dev-A", [a]), batch("dev-B", [b])], zones });
  const entries = result.items.filter((item) => item.opId === "same");
  assert.equal(entries.length, 2);
  assert.ok(entries.every((item) => item.status === "review"));
});

test("摘要统计与导出共用同一份结果", () => {
  const a = makeOp({ id: "m-1", vehicle: "沪J-1", driver: "甲", zone: "城北", taskId: "M1", issuedAt: 1000 });
  const b = makeOp({ id: "m-2", vehicle: "沪J-1", driver: "乙", zone: "城北", taskId: "M2", issuedAt: 2000 });
  const result = mergeDispatch({ committed: [], batches: [batch("dev-A", [a, b])], zones });
  assert.equal(result.summary.accepted + result.summary.superseded, 2);
  assert.equal(result.reviewItems.length, result.summary.review);
  assert.equal(result.summary.batchCount, 1);
});

test("演示场景：发起时刻仲裁、车辆唯一占用、司机冲突、容量排队、同刻编辑冲突同时成立", () => {
  const result = mergeDispatch({ committed: [], batches: buildDemoBatches(), zones });
  const byId = new Map(result.items.map((item) => [item.opId, item]));

  // a3 发起最新覆盖 a1，即使 a1 所属批次更晚上传
  assert.equal(byId.get("demo-a3")?.status, "accepted");
  assert.equal(byId.get("demo-a1")?.status, "superseded");
  // 沪A-82L6 早班只有一条有效占用
  assert.equal(result.vehicleOccupancy.filter((o) => o.vehicle === "沪A-82L6").length, 1);

  // 蒋琳同班次在两台车上：a2(沪A-55T2/城北) 与 b2(沪C-77Q1/城东) → 双方待核对
  assert.equal(byId.get("demo-a2")?.status, "review");
  assert.equal(byId.get("demo-b2")?.status, "review");

  // 城北容量 2：a3(20分)、b3(25分) 有效，a4(35分) 排队
  assert.equal(byId.get("demo-a3")?.status, "accepted");
  assert.equal(byId.get("demo-b3")?.status, "accepted");
  assert.equal(byId.get("demo-a4")?.status, "queued");

  // 多设备同刻改 T-1002，内容不一致 → 双方待核对
  assert.equal(byId.get("demo-edit-a")?.status, "review");
  assert.equal(byId.get("demo-edit-b")?.status, "review");

  // b1 城东独占 → 有效（发起早、上传早，无争议）
  assert.equal(byId.get("demo-b1")?.status, "accepted");

  assert.deepEqual(
    {
      accepted: result.summary.accepted,
      queued: result.summary.queued,
      review: result.summary.review,
      superseded: result.summary.superseded
    },
    { accepted: 3, queued: 1, review: 4, superseded: 1 }
  );
});
