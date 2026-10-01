import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import type { DispatchOp, MergeResult, OutboxBatch, ZoneConfig } from "../types";
import { mergeDispatch } from "../merge/offlineMerge";
import { buildDemoBatches } from "../merge/demoData";

const LS_ZONES = "dfwlfront-3-zones";
const LS_COMMITTED = "dfwlfront-3-committed";
const LS_OUTBOX = "dfwlfront-3-outbox";
const LS_DEVICE = "dfwlfront-3-device";

function load<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export const defaultZones: ZoneConfig[] = [
  { zone: "城北", capacity: 2, queueLimit: 1 },
  { zone: "城东", capacity: 2, queueLimit: 2 },
  { zone: "城南", capacity: 1, queueLimit: 1 }
];

export const useDispatchStore = defineStore("dispatch", () => {
  /** 区域容量配置 */
  const zones = ref<ZoneConfig[]>(load(LS_ZONES, defaultZones));
  /** 上一次已确认同步的有效派车记录 */
  const committed = ref<DispatchOp[]>(load(LS_COMMITTED, []));
  /** 写入失败或尚未同步的本地批次（修正后重试，永不因失败丢失） */
  const outbox = ref<OutboxBatch[]>(load(LS_OUTBOX, []));
  /** 当前设备标识；切换设备可模拟多设备离线派车 */
  const deviceId = ref<string>(load(LS_DEVICE, "调度台-01"));
  /** 打开后模拟下一次同步写入失败 */
  const failNextWrite = ref(false);
  const syncing = ref(false);
  const lastSyncAt = ref<number | null>(null);
  const syncError = ref<string | null>(null);

  function persist() {
    localStorage.setItem(LS_ZONES, JSON.stringify(zones.value));
    localStorage.setItem(LS_COMMITTED, JSON.stringify(committed.value));
    localStorage.setItem(LS_OUTBOX, JSON.stringify(outbox.value));
    localStorage.setItem(LS_DEVICE, JSON.stringify(deviceId.value));
  }
  watch([zones, committed, outbox, deviceId], persist, { deep: true });

  /** 调度台 / 核对区 / 导出摘要共用的唯一合并结果 */
  const mergeResult = computed<MergeResult>(() =>
    mergeDispatch({
      committed: committed.value,
      batches: outbox.value,
      zones: zones.value
    })
  );

  const pendingBatches = computed(() =>
    [...outbox.value].sort((a, b) => a.createdAt - b.createdAt)
  );

  /** 离线发起一笔派车，先落本地批次 */
  function enqueueAssign(input: {
    vehicle: string;
    driver: string;
    zone: string;
    taskId: string;
    taskTitle: string;
    issuedAt?: number;
  }): string {
    const now = Date.now();
    const op: DispatchOp = {
      id: crypto.randomUUID(),
      batchId: crypto.randomUUID(),
      deviceId: deviceId.value,
      issuedAt: input.issuedAt ?? now,
      uploadedAt: now,
      shift: currentShift(input.issuedAt ?? now),
      vehicle: input.vehicle,
      driver: input.driver,
      zone: input.zone,
      taskId: input.taskId,
      taskTitle: input.taskTitle,
      taskVersion: 1,
      type: "assign"
    };
    outbox.value.push({
      id: op.batchId,
      deviceId: deviceId.value,
      createdAt: now,
      ops: [op],
      retryCount: 0
    });
    return op.id;
  }

  /** 离线编辑任务（不同设备可能产生同刻版本冲突） */
  function enqueueTaskEdit(input: {
    taskId: string;
    taskTitle: string;
    taskVersion: number;
    zone: string;
    issuedAt?: number;
  }): string {
    const now = Date.now();
    const op: DispatchOp = {
      id: crypto.randomUUID(),
      batchId: crypto.randomUUID(),
      deviceId: deviceId.value,
      issuedAt: input.issuedAt ?? now,
      uploadedAt: now,
      shift: currentShift(input.issuedAt ?? now),
      vehicle: "",
      driver: "",
      zone: input.zone,
      taskId: input.taskId,
      taskTitle: input.taskTitle,
      taskVersion: input.taskVersion,
      type: "editTask"
    };
    outbox.value.push({
      id: op.batchId,
      deviceId: deviceId.value,
      createdAt: now,
      ops: [op],
      retryCount: 0
    });
    return op.id;
  }

  /**
   * 重连后同步：把本地批次写入服务端。
   * 写入失败时批次原样保留、记录错误与重试次数，修正后可再次重试。
   */
  async function syncNow(): Promise<{ ok: boolean; error?: string }> {
    if (syncing.value) return { ok: false, error: "正在同步中" };
    syncing.value = true;
    syncError.value = null;
    try {
      await fakeServerWrite(failNextWrite.value);
    } catch (error) {
      const message = error instanceof Error ? error.message : "写入失败";
      for (const batch of outbox.value) {
        batch.retryCount += 1;
        batch.lastError = message;
      }
      syncError.value = message;
      failNextWrite.value = false;
      return { ok: false, error: message };
    } finally {
      syncing.value = false;
    }

    const result = mergeResult.value;
    // 冲突未决的记录不入库；已被取代的旧版本不入库
    const validIds = new Set(
      result.items
        .filter((item) => item.status === "accepted" || item.status === "queued")
        .map((item) => item.opId)
    );

    const seenIds = new Set<string>();
    const accepted: DispatchOp[] = [];
    for (const batch of outbox.value) {
      for (const op of batch.ops) {
        if (seenIds.has(op.id) || !validIds.has(op.id)) continue;
        seenIds.add(op.id);
        // 保留 forceAccepted / resolveNote：人工裁定结论需随已确认记录持久化，
        // 否则下次重算会与剩余冲突记录再次撞车
        accepted.push(op);
      }
    }
    const incomingIds = new Set(accepted.map((op) => op.id));
    committed.value = [...committed.value.filter((op) => !incomingIds.has(op.id)), ...accepted].sort(
      (a, b) => a.issuedAt - b.issuedAt
    );
    // 待核对 / 已取代的记录随批次保留，直到核对区处理或作废
    outbox.value = outbox.value
      .map((batch) => ({
        ...batch,
        ops: batch.ops.filter((op) => !validIds.has(op.id)),
        retryCount: 0,
        lastError: undefined
      }))
      .filter((batch) => batch.ops.length > 0);

    lastSyncAt.value = Date.now();
    failNextWrite.value = false;
    return { ok: true };
  }

  /** 核对区：人工核实后强制确认占用（容量规则仍执行） */
  function forceAccept(opId: string, note: string) {
    mutateOutboxOp(opId, (op) => {
      op.forceAccepted = true;
      op.resolveNote = note;
    });
  }

  /** 核对区：作废该记录（从待写批次中移除） */
  function discardOp(opId: string, note: string) {
    void note;
    for (const batch of outbox.value) {
      batch.ops = batch.ops.filter((op) => op.id !== opId);
    }
    outbox.value = outbox.value.filter((batch) => batch.ops.length > 0);
  }

  /** 核对区：修正后以新版本重新提交，原记录留待同步时作废 */
  function reviseOp(opId: string, patch: Partial<DispatchOp>): string {
    const source = outbox.value.flatMap((batch) => batch.ops).find((op) => op.id === opId);
    if (!source) throw new Error("待核对记录已不在本地批次中");
    const now = Date.now();
    const newId = crypto.randomUUID();
    const revised: DispatchOp = {
      ...source,
      ...patch,
      id: newId,
      batchId: crypto.randomUUID(),
      deviceId: deviceId.value,
      issuedAt: patch.issuedAt ?? source.issuedAt,
      uploadedAt: now,
      taskVersion: source.type === "editTask" ? source.taskVersion + 1 : source.taskVersion,
      forceAccepted: false,
      resolveNote: undefined
    };
    outbox.value.push({
      id: revised.batchId,
      deviceId: deviceId.value,
      createdAt: now,
      ops: [revised],
      retryCount: 0
    });
    // 原记录从旧批次移除
    removeFromOutbox(source);
    return newId;
  }

  function mutateOutboxOp(opId: string, apply: (op: DispatchOp, batch: OutboxBatch) => void) {
    for (const batch of outbox.value) {
      const op = batch.ops.find((item) => item.id === opId);
      if (op) {
        apply(op, batch);
        return;
      }
    }
  }

  function removeFromOutbox(op: DispatchOp) {
    for (const batch of outbox.value) {
      batch.ops = batch.ops.filter((item) => item.id !== op.id);
    }
    outbox.value = outbox.value.filter((batch) => batch.ops.length > 0);
  }

  function setDevice(id: string) {
    deviceId.value = id;
  }

  function updateZoneCapacity(zone: string, capacity: number, queueLimit: number) {
    const existing = zones.value.find((item) => item.zone === zone);
    if (existing) {
      existing.capacity = capacity;
      existing.queueLimit = queueLimit;
    } else {
      zones.value.push({ zone, capacity, queueLimit });
    }
  }

  /** 一键装载离线重连演示数据（含全部规则场景） */
  function loadDemoScenario() {
    localStorage.removeItem(LS_COMMITTED);
    committed.value = [];
    outbox.value = buildDemoBatches();
    lastSyncAt.value = null;
    syncError.value = null;
  }

  function resetAll() {
    committed.value = [];
    outbox.value = [];
    syncError.value = null;
    lastSyncAt.value = null;
    failNextWrite.value = false;
  }

  return {
    zones,
    committed,
    outbox,
    deviceId,
    failNextWrite,
    syncing,
    lastSyncAt,
    syncError,
    mergeResult,
    pendingBatches,
    enqueueAssign,
    enqueueTaskEdit,
    syncNow,
    forceAccept,
    discardOp,
    reviseOp,
    setDevice,
    updateZoneCapacity,
    loadDemoScenario,
    resetAll
  };
});

/** 模拟服务端写入：可被「模拟下一次失败」开关打断 */
function fakeServerWrite(shouldFail: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (shouldFail) reject(new Error("网络不可达，写入被拒绝（模拟）"));
      else resolve();
    }, 350);
  });
}

/** 简单班次划分：12 点前早班，18 点前中班，其余晚班 */
export function currentShift(ts: number): string {
  const d = new Date(ts);
  const day = d.toISOString().slice(0, 10);
  const hour = d.getHours();
  const shift = hour < 12 ? "早班" : hour < 18 ? "中班" : "晚班";
  return `${day}/${shift}`;
}
