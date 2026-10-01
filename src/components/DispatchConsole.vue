<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useDispatchStore } from "../store/dispatch";
import type { MergeStatus } from "../types";

const store = useDispatchStore();

const zones = computed(() => store.zones.map((zone) => zone.zone));

const form = reactive({
  vehicle: "",
  driver: "",
  zone: zones.value[0] ?? "",
  taskId: "",
  taskTitle: "",
  /** 默认当前发起时刻，允许回拨模拟离线期间的真实发起时间 */
  issuedAtInput: toDatetimeLocal(Date.now())
});

const editForm = reactive({
  taskId: "",
  taskTitle: "",
  taskVersion: 2,
  zone: zones.value[0] ?? "",
  issuedAtInput: toDatetimeLocal(Date.now())
});

const tab = ref<"assign" | "edit">("assign");
const flash = ref<string | null>(null);

const statusLabel: Record<MergeStatus, string> = {
  accepted: "有效",
  queued: "排队",
  review: "待核对",
  superseded: "已失效"
};

const result = computed(() => store.mergeResult);

const visibleItems = computed(() =>
  result.value.items.filter((item) => filter.value === "all" || item.status === filter.value)
);
const filter = ref<"all" | MergeStatus>("all");

function toDatetimeLocal(ts: number) {
  const d = new Date(ts - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

function submitAssign() {
  const issuedAt = new Date(form.issuedAtInput).getTime();
  store.enqueueAssign({
    vehicle: form.vehicle.trim(),
    driver: form.driver.trim(),
    zone: form.zone,
    taskId: form.taskId.trim(),
    taskTitle: form.taskTitle.trim(),
    issuedAt
  });
  flash.value = "派车已写入本地批次，重连后参与合并";
  setTimeout(() => (flash.value = null), 2500);
  form.vehicle = form.driver = form.taskId = form.taskTitle = "";
}

function submitEdit() {
  const issuedAt = new Date(editForm.issuedAtInput).getTime();
  store.enqueueTaskEdit({
    taskId: editForm.taskId.trim(),
    taskTitle: editForm.taskTitle.trim(),
    taskVersion: editForm.taskVersion,
    zone: editForm.zone,
    issuedAt
  });
  flash.value = "任务编辑已写入本地批次";
  setTimeout(() => (flash.value = null), 2500);
  editForm.taskId = editForm.taskTitle = "";
}

function fmt(ts: number) {
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}
</script>

<template>
  <div class="console">
    <section class="panel">
      <div class="panel-tabs">
        <button :class="{ active: tab === 'assign' }" type="button" @click="tab = 'assign'">
          离线派车
        </button>
        <button :class="{ active: tab === 'edit' }" type="button" @click="tab = 'edit'">
          任务改期/改址
        </button>
      </div>

      <form v-if="tab === 'assign'" class="form-grid" @submit.prevent="submitAssign">
        <label>车牌号<input v-model="form.vehicle" required placeholder="沪A-82L6" /></label>
        <label>司机<input v-model="form.driver" required placeholder="董飞" /></label>
        <label>配送区域
          <select v-model="form.zone">
            <option v-for="zone in zones" :key="zone" :value="zone">{{ zone }}</option>
          </select>
        </label>
        <label>任务编号<input v-model="form.taskId" required placeholder="T-1001" /></label>
        <label>任务内容<input v-model="form.taskTitle" required placeholder="商超补货" /></label>
        <label>发起时刻
          <input v-model="form.issuedAtInput" type="datetime-local" required />
        </label>
        <button type="submit" class="wide">记入本地批次</button>
      </form>

      <form v-else class="form-grid" @submit.prevent="submitEdit">
        <label>任务编号<input v-model="editForm.taskId" required placeholder="T-1002" /></label>
        <label>新版本内容<input v-model="editForm.taskTitle" required placeholder="改 10 点送达" /></label>
        <label>任务版本<input v-model.number="editForm.taskVersion" type="number" min="1" required /></label>
        <label>原任务区域
          <select v-model="editForm.zone">
            <option v-for="zone in zones" :key="zone" :value="zone">{{ zone }}</option>
          </select>
        </label>
        <label>发起时刻
          <input v-model="editForm.issuedAtInput" type="datetime-local" required />
        </label>
        <button type="submit" class="wide">编辑写入本地批次</button>
      </form>

      <p v-if="flash" class="flash">{{ flash }}</p>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>合并结果 <small>调度台 / 核对区 / 导出共用同一份计算</small></h2>
        <div class="filter-row">
          <button
            v-for="opt in [
              { key: 'all', label: `全部 ${result.summary.totalOps}` },
              { key: 'accepted', label: `有效 ${result.summary.accepted}` },
              { key: 'queued', label: `排队 ${result.summary.queued}` },
              { key: 'review', label: `待核对 ${result.summary.review}` },
              { key: 'superseded', label: `已失效 ${result.summary.superseded}` }
            ]"
            :key="opt.key"
            type="button"
            class="chip"
            :class="{ active: filter === opt.key }"
            @click="filter = opt.key as typeof filter"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>

      <div class="merge-table-wrap">
        <table class="merge-table">
          <thead>
            <tr>
              <th>状态</th>
              <th>类型</th>
              <th>发起时刻</th>
              <th>车辆 / 司机</th>
              <th>区域</th>
              <th>任务（合并后有效版本）</th>
              <th>来源</th>
              <th>判定原因</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in visibleItems" :key="item.rowKey" :class="['row-' + item.status]">
              <td><span :class="['badge', 'badge-' + item.status]">{{ statusLabel[item.status] }}</span></td>
              <td>{{ item.op.type === 'assign' ? '派车' : '编辑' }}</td>
              <td>{{ fmt(item.op.issuedAt) }}</td>
              <td>{{ item.op.vehicle || '—' }}<template v-if="item.op.driver"> / {{ item.op.driver }}</template></td>
              <td>{{ item.op.zone }}</td>
              <td>
                {{ item.effectiveTaskTitle }}
                <em v-if="item.op.type === 'assign' && item.effectiveTaskVersion && item.effectiveTaskVersion > 1">
                  v{{ item.effectiveTaskVersion }}
                </em>
              </td>
              <td>
                {{ item.op.deviceId }}
                <span v-if="item.committed" class="tag-committed">已确认</span>
              </td>
              <td class="reason">{{ item.reason }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <h2>当前有效占用与区域容量</h2>
      <div class="occupancy-grid">
        <div class="occ-list">
          <p v-if="result.vehicleOccupancy.length === 0" class="muted">暂无有效占用</p>
          <div v-for="occ in result.vehicleOccupancy" :key="occ.opId" class="occ-item">
            <strong>{{ occ.vehicle }}</strong>
            <span>{{ occ.driver }} · {{ occ.zone }}</span>
            <small>{{ occ.shift }} · {{ fmt(occ.issuedAt) }}</small>
          </div>
        </div>
        <div class="zone-list">
          <div v-for="zone in result.zones" :key="zone.zone" class="zone-item">
            <strong>{{ zone.zone }}</strong>
            <span>容量 {{ zone.active }}/{{ zone.capacity }}</span>
            <span>排队 {{ zone.queued }}/{{ zone.queueLimit }}</span>
            <span v-if="zone.review" class="warn">待核对 {{ zone.review }}</span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
