import test from "node:test";
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { useDispatchStore } from "../src/store/dispatch";

// ---- Node 环境下的浏览器桩 ----
const memStore = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => (memStore.has(key) ? memStore.get(key)! : null),
  setItem: (key: string, value: string) => void memStore.set(key, String(value)),
  removeItem: (key: string) => void memStore.delete(key),
  clear: () => memStore.clear()
};
Object.defineProperty(globalThis, "localStorage", { value: localStorageStub, configurable: true });
Object.defineProperty(globalThis, "crypto", {
  value: { randomUUID: () => "id-" + Math.random().toString(36).slice(2) },
  configurable: true
});

function newStore() {
  memStore.clear();
  setActivePinia(createPinia());
  return useDispatchStore();
}

test("写入失败：批次原样保留并记录重试次数；修正后重试成功", async () => {
  const store = newStore();
  store.enqueueAssign({
    vehicle: "沪A-1",
    driver: "董飞",
    zone: "城北",
    taskId: "T1",
    taskTitle: "商超补货"
  });
  assert.equal(store.outbox.length, 1);

  // 第一次写入失败
  store.failNextWrite = true;
  const failed = await store.syncNow();
  assert.equal(failed.ok, false);
  assert.equal(store.outbox.length, 1, "失败后批次必须保留");
  assert.equal(store.outbox[0].retryCount, 1);
  assert.match(store.outbox[0].lastError ?? "", /网络不可达/);
  assert.equal(store.committed.length, 0);
  assert.equal(store.syncError, "网络不可达，写入被拒绝（模拟）");

  // 修正（关闭模拟失败）后重试
  const retried = await store.syncNow();
  assert.equal(retried.ok, true);
  assert.equal(store.outbox.length, 0, "成功后批次清空");
  assert.equal(store.committed.length, 1);
  assert.equal(store.committed[0].vehicle, "沪A-1");
});

test("同步成功只入库有效与排队记录，待核对记录保留在本地", async () => {
  const store = newStore();
  // 同一司机双车 → 两条 review
  store.enqueueAssign({ vehicle: "沪E-1", driver: "王师傅", zone: "城北", taskId: "D1", taskTitle: "甲单" });
  store.enqueueAssign({ vehicle: "沪E-2", driver: "王师傅", zone: "城东", taskId: "D2", taskTitle: "乙单" });

  const res = await store.syncNow();
  assert.equal(res.ok, true);
  assert.equal(store.committed.length, 0, "冲突记录不入库");
  assert.equal(store.outbox.reduce((n, b) => n + b.ops.length, 0), 2, "待核对记录保留批次");

  // 核对区强制确认其中一条后重试
  const reviewId = store.mergeResult.reviewItems[0].opId;
  store.forceAccept(reviewId, "电话核实");
  const res2 = await store.syncNow();
  assert.equal(res2.ok, true);
  assert.equal(store.committed.length, 1);
  // 另一条仍待核对
  assert.equal(store.mergeResult.reviewItems.length, 1);
});

test("作废待核对记录后批次相应收缩", async () => {
  const store = newStore();
  store.enqueueAssign({ vehicle: "沪E-1", driver: "王师傅", zone: "城北", taskId: "D1", taskTitle: "甲单" });
  store.enqueueAssign({ vehicle: "沪E-2", driver: "王师傅", zone: "城东", taskId: "D2", taskTitle: "乙单" });
  const [first, second] = store.mergeResult.reviewItems;
  store.discardOp(first.opId, "重复派车");
  const ids = store.outbox.flatMap((b) => b.ops.map((op) => op.id));
  assert.deepEqual(ids.sort(), [second.opId].sort());
});

test("状态持久化到 localStorage，重开后可重建合并结果", async () => {
  const store = newStore();
  store.enqueueAssign({ vehicle: "沪F-9", driver: "钱师傅", zone: "城东", taskId: "O1", taskTitle: "样品" });
  await store.syncNow();
  assert.ok(memStore.get("dfwlfront-3-committed")?.includes("沪F-9"));

  setActivePinia(createPinia());
  const reopened = useDispatchStore();
  assert.equal(reopened.committed.length, 1);
  assert.equal(reopened.mergeResult.summary.accepted, 1);
});
