<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useDispatchStore } from "../store/dispatch";
import type { MergeItem } from "../types";

const store = useDispatchStore();
const reviewItems = computed(() => store.mergeResult.reviewItems);

const notes = reactive<Record<string, string>>({});
const revisingId = ref<string | null>(null);
const reviseDraft = reactive({
  vehicle: "",
  driver: "",
  zone: "",
  taskTitle: "",
  issuedAtInput: ""
});

function startRevise(item: MergeItem) {
  revisingId.value = item.opId;
  reviseDraft.vehicle = item.op.vehicle;
  reviseDraft.driver = item.op.driver;
  reviseDraft.zone = item.op.zone;
  reviseDraft.taskTitle = item.op.effectiveTaskTitle ?? item.op.taskTitle;
  reviseDraft.issuedAtInput = toDatetimeLocal(item.op.issuedAt);
}

function toDatetimeLocal(ts: number) {
  const d = new Date(ts - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

function submitRevise(item: MergeItem) {
  store.reviseOp(item.opId, {
    vehicle: reviseDraft.vehicle.trim(),
    driver: reviseDraft.driver.trim(),
    zone: reviseDraft.zone,
    taskTitle: reviseDraft.taskTitle.trim(),
    issuedAt: new Date(reviseDraft.issuedAtInput).getTime()
  });
  revisingId.value = null;
}

function fmt(ts: number) {
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

const capacityDraft = reactive<Record<string, { capacity: number; queueLimit: number }>>({});
for (const zone of store.zones) {
  capacityDraft[zone.zone] = { capacity: zone.capacity, queueLimit: zone.queueLimit };
}
function saveCapacity(zone: string) {
  const draft = capacityDraft[zone];
  store.updateZoneCapacity(zone, Number(draft.capacity), Number(draft.queueLimit));
}
</script>

<template>
  <div class="review-panel">
    <section class="panel">
      <h2>核对区 <small>冲突无法自动判定时统一在此处理，修正后重算并重试同步</small></h2>

      <p v-if="reviewItems.length === 0" class="muted big">没有待核对记录，合并结果一致。</p>

      <div v-for="item in reviewItems" :key="item.rowKey" class="review-card">
        <div class="review-head">
          <span class="badge badge-review">待核对</span>
          <strong>
            {{ item.op.type === 'assign' ? `${item.op.vehicle} / ${item.op.driver}` : '任务编辑' }}
          </strong>
          <span class="muted">{{ item.op.zone }} · {{ item.op.shift }}</span>
          <span class="muted">{{ item.op.deviceId }} · 发起 {{ fmt(item.op.issuedAt) }}</span>
        </div>
        <p class="reason-box">{{ item.reason }}</p>
        <p class="muted">
          任务：{{ item.effectiveTaskTitle }}
          <em>v{{ item.effectiveTaskVersion }}</em>
          <template v-if="item.op.taskTitle !== item.effectiveTaskTitle">
            （本记录内容：{{ item.op.taskTitle }}）
          </template>
        </p>

        <div v-if="revisingId === item.opId" class="revise-form">
          <label>车辆<input v-model="reviseDraft.vehicle" :disabled="item.op.type === 'editTask'" /></label>
          <label>司机<input v-model="reviseDraft.driver" :disabled="item.op.type === 'editTask'" /></label>
          <label>区域
            <select v-model="reviseDraft.zone">
              <option v-for="zone in store.zones" :key="zone.zone" :value="zone.zone">{{ zone.zone }}</option>
            </select>
          </label>
          <label>任务内容<input v-model="reviseDraft.taskTitle" /></label>
          <label>发起时刻<input v-model="reviseDraft.issuedAtInput" type="datetime-local" /></label>
          <div class="revise-actions">
            <button type="button" @click="submitRevise(item)">以新版本提交</button>
            <button type="button" class="secondary" @click="revisingId = null">取消</button>
          </div>
        </div>

        <div v-else class="review-actions">
          <input v-model="notes[item.opId]" placeholder="核对说明（可选，如：电话核实）" />
          <button type="button" @click="store.forceAccept(item.opId, notes[item.opId] ?? '核对无误')">
            核实有效，放行
          </button>
          <button type="button" class="secondary" @click="startRevise(item)">修正重提</button>
          <button type="button" class="danger" @click="store.discardOp(item.opId, notes[item.opId] ?? '')">
            作废
          </button>
        </div>
      </div>
    </section>

    <section class="panel two-col">
      <div>
        <h2>本地批次与重试</h2>
        <p v-if="store.outbox.length === 0" class="muted">无待写批次。</p>
        <div v-for="batch in store.pendingBatches" :key="batch.id" class="batch-item">
          <strong>{{ batch.deviceId }}</strong>
          <span>{{ batch.id }}</span>
          <span>{{ batch.ops.length }} 笔待写</span>
          <span v-if="batch.retryCount > 0" class="warn">已重试 {{ batch.retryCount }} 次</span>
          <p v-if="batch.lastError" class="error-text">上次失败：{{ batch.lastError }}</p>
        </div>
        <p class="muted small">写入失败后批次不会丢失，修正冲突或关闭「模拟失败」后点顶部「重试同步」即可。</p>
      </div>

      <div>
        <h2>区域容量配置</h2>
        <p class="muted small">调高容量或排队上限后，溢出的派车会立即重新排队 / 生效。</p>
        <div v-for="zone in store.zones" :key="zone.zone" class="capacity-row">
          <strong>{{ zone.zone }}</strong>
          <label>容量<input v-model.number="capacityDraft[zone.zone].capacity" type="number" min="0" /></label>
          <label>排队上限<input v-model.number="capacityDraft[zone.zone].queueLimit" type="number" min="0" /></label>
          <button type="button" class="secondary" @click="saveCapacity(zone.zone)">保存</button>
        </div>
      </div>
    </section>
  </div>
</template>
