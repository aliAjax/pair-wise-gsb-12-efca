import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { uploadBatch } from "./api";
import { mergeDispatch } from "./merge";
import { BASE_TASKS, CAPACITIES, SEED_BATCHES, ZONES } from "./seed";
import type {
  DispatchBatch,
  DispatchOp,
  EffectiveOccupancy,
  ReviewItem,
  Shift,
  TaskEdit
} from "./types";

const BATCH_KEY = "dfwlfront-3-batches-v1";
const RESOLUTION_KEY = "dfwlfront-3-resolutions-v1";

function loadBatches(): DispatchBatch[] {
  const raw = localStorage.getItem(BATCH_KEY);
  if (!raw) return structuredClone(SEED_BATCHES);
  try {
    return JSON.parse(raw) as DispatchBatch[];
  } catch {
    return structuredClone(SEED_BATCHES);
  }
}

export const useDispatchStore = defineStore("dispatch", () => {
  const batches = ref<DispatchBatch[]>(loadBatches());
  const online = ref(true);
  /** 触发写入失败：在线但服务端拒绝（用于演示失败后修正重试） */
  const forceFailure = ref(false);
  const syncing = ref<Set<string>>(new Set());
  const resolutions = ref<Map<string, ReviewItem["resolution"]>>(loadResolutions());
  const notice = ref<string>("");

  function loadResolutions(): Map<string, ReviewItem["resolution"]> {
    const raw = localStorage.getItem(RESOLUTION_KEY);
    if (!raw) return new Map();
    try {
      return new Map(Object.entries(JSON.parse(raw) as Record<string, ReviewItem["resolution"]>));
    } catch {
      return new Map();
    }
  }

  function persistBatches(): void {
    localStorage.setItem(BATCH_KEY, JSON.stringify(batches.value));
  }

  function persistResolutions(): void {
    localStorage.setItem(
      RESOLUTION_KEY,
      JSON.stringify(Object.fromEntries(resolutions.value))
    );
  }

  const allOps = computed<DispatchOp[]>(() =>
    batches.value.flatMap((b) => b.ops).sort((a, b) => a.issuedAt.localeCompare(b.issuedAt))
  );

  const allEdits = computed<TaskEdit[]>(() => batches.value.flatMap((b) => b.taskEdits));

  /** 调度台、核对区、导出摘要共用的唯一合并结果 */
  const mergeResult = computed(() =>
    mergeDispatch(
      {
        ops: allOps.value,
        taskEdits: allEdits.value,
        baseTasks: BASE_TASKS,
        capacities: CAPACITIES
      },
      { resolutions: resolutions.value }
    )
  );

  const pendingBatches = computed(() =>
    batches.value.filter((b) => b.status === "pending" || b.status === "failed")
  );

  function flash(message: string): void {
    notice.value = message;
    window.setTimeout(() => {
      if (notice.value === message) notice.value = "";
    }, 3200);
  }

  /** 写入失败后重试；批次始终保留在本地，直到服务端确认 */
  async function syncBatch(batchId: string): Promise<void> {
    const batch = batches.value.find((b) => b.id === batchId);
    if (!batch || syncing.value.has(batchId)) return;
    syncing.value.add(batchId);
    try {
      const res = await uploadBatch(batch, {
        online: online.value,
        serverFault: forceFailure.value
      });
      const index = batches.value.findIndex((b) => b.id === batchId);
      if (res.ok) {
        batches.value[index] = {
          ...batch,
          status: "synced",
          uploadedAt: res.uploadedAt,
          lastError: undefined
        };
        flash(`批次 ${batchId} 写入成功，合并结果已更新`);
      } else {
        // 失败：本地批次原样保留，等待修正后重试
        batches.value[index] = { ...batch, status: "failed", lastError: res.error };
        flash(`批次 ${batchId} 写入失败，已保留：${res.error}`);
      }
      persistBatches();
    } finally {
      syncing.value.delete(batchId);
    }
  }

  async function syncAll(): Promise<void> {
    const targets = pendingBatches.value.map((b) => b.id);
    for (const id of targets) await syncBatch(id);
  }

  /** 失败/待传批次的就地修正（改区域/司机/车辆/任务版本等），修正后再重试 */
  function patchOp(opId: string, patch: Partial<DispatchOp>): string | undefined {
    const batch = batches.value.find((b) =>
      b.ops.some((op) => op.id === opId)
    );
    if (!batch) return undefined;
    batch.ops = batch.ops.map((op) => (op.id === opId ? { ...op, ...patch } : op));
    if (batch.status === "failed") batch.lastError = "已按核对意见修正，待重新写入";
    persistBatches();
    return batch.id;
  }

  function saveResolution(id: string, resolution: ReviewItem["resolution"]): void {
    resolutions.value.set(id, resolution);
    persistResolutions();
    // Map 替换以触发 computed 重新计算
    resolutions.value = new Map(resolutions.value);
  }

  function clearResolution(id: string): void {
    resolutions.value.delete(id);
    persistResolutions();
    resolutions.value = new Map(resolutions.value);
  }

  function resetDemo(): void {
    batches.value = structuredClone(SEED_BATCHES);
    resolutions.value = new Map();
    persistBatches();
    persistResolutions();
    flash("已恢复演示数据");
  }

  function effectiveOf(opId: string): EffectiveOccupancy | undefined {
    return mergeResult.value.effective.find((o) => o.opId === opId);
  }

  return {
    batches,
    online,
    forceFailure,
    syncing,
    resolutions,
    notice,
    allOps,
    allEdits,
    mergeResult,
    pendingBatches,
    syncBatch,
    syncAll,
    patchOp,
    saveResolution,
    clearResolution,
    resetDemo,
    effectiveOf,
    zones: ZONES
  };
});

export type ShiftValue = Shift;
