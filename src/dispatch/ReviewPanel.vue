<script setup lang="ts">
import { computed, reactive } from "vue";
import { useDispatchStore } from "./store";
import { fmtDateTime, fmtTime } from "./format";
import type { ReviewItem } from "./types";
import { reasonText } from "./exporter";

const store = useDispatchStore();
const result = computed(() => store.mergeResult);

const allOpById = computed(() => new Map(store.allOps.map((op) => [op.id, op])));
const editById = computed(() => new Map(store.allEdits.map((e) => [e.id, e])));

const pendingList = computed(() => result.value.reviews.filter((r) => !r.resolution));
const resolvedList = computed(() => result.value.reviews.filter((r) => r.resolution));

const editing = reactive<Record<string, string>>({});
const zoneFix = reactive<Record<string, string>>({});

function noteProxy(review: ReviewItem) {
  return {
    get value() {
      return editing[review.id] ?? review.resolution?.note ?? "";
    },
    set value(v: string) {
      editing[review.id] = v;
    }
  };
}

function decide(review: ReviewItem, action: string) {
  store.saveResolution(review.id, {
    action,
    note: editing[review.id]?.trim() || undefined,
    at: new Date().toISOString()
  });
  delete editing[review.id];
}

function undo(review: ReviewItem) {
  store.clearResolution(review.id);
  delete editing[review.id];
}

function statusText(review: ReviewItem): string {
  if (!review.resolution) return "待核对";
  if (review.reason === "task-conflict") return "已裁定";
  return review.resolution.action === "reject" ? "已驳回" : "已放行";
}
</script>

<template>
  <div class="review">
    <div class="review-head">
      <p class="hint">
        冲突无法按发起时刻自动判定时进入核对区；人工结论持久化保存，合并结果随之复算，调度台与导出摘要同步更新。
      </p>
      <div class="review-counts">
        <span class="chip chip-warn">待核对 {{ pendingList.length }}</span>
        <span class="chip chip-ok">已裁定 {{ resolvedList.length }}</span>
      </div>
    </div>

    <h3>待核对（{{ pendingList.length }}）</h3>
    <div v-if="pendingList.length === 0" class="empty-box">暂无待核对项，合并结果一致。</div>

    <article v-for="r in pendingList" :key="r.id" class="review-card">
      <header>
        <span class="badge badge-warn">{{ reasonText(r.reason) }}</span>
        <strong>{{ r.title }}</strong>
        <span class="muted">最晚发起 {{ fmtDateTime(r.issuedAt) }}</span>
      </header>
      <p class="review-msg">{{ r.message }}</p>

      <div v-if="r.opIds?.length" class="review-ops">
        <div v-for="id in r.opIds" :key="id" class="op-line" v-show="allOpById.get(id)">
          <template v-if="allOpById.get(id)">
            <span class="muted">{{ fmtTime(allOpById.get(id)!.issuedAt) }}</span>
            <span>{{ allOpById.get(id)!.vehicleId }}</span>
            <span>{{ allOpById.get(id)!.driver }}</span>
            <span>{{ allOpById.get(id)!.zone }}{{ allOpById.get(id)!.shift }}</span>
            <span>任务 {{ allOpById.get(id)!.taskId }}(v{{ allOpById.get(id)!.taskVersion }})</span>
            <span class="muted">来源 {{ allOpById.get(id)!.deviceId }}</span>
          </template>
        </div>
      </div>

      <div v-if="r.editIds?.length" class="review-ops">
        <div v-for="id in r.editIds" :key="id" class="op-line">
          <template v-if="editById.get(id)">
            <span class="muted">{{ fmtTime(editById.get(id)!.issuedAt) }}</span>
            <span>设备 {{ editById.get(id)!.deviceId }}</span>
            <span>基于 v{{ editById.get(id)!.baseVersion }}</span>
            <span v-if="editById.get(id)!.zone">改为区域 {{ editById.get(id)!.zone }}</span>
            <span v-if="editById.get(id)!.title">改为「{{ editById.get(id)!.title }}」</span>
          </template>
        </div>
      </div>

      <div v-if="r.reason === 'zone-unknown' && r.opIds?.[0]" class="review-actions">
        <select v-model="zoneFix[r.id]" class="zone-fix">
          <option value="">改派到已纳管区域…</option>
          <option value="城北">城北</option>
          <option value="城东">城东</option>
          <option value="城南">城南</option>
        </select>
        <button
          type="button"
          class="secondary"
          :disabled="!zoneFix[r.id]"
          @click="zoneFix[r.id] && store.patchOp(r.opIds[0], { zone: zoneFix[r.id] })"
        >
          修正区域并重算
        </button>
        <span class="muted small">修正后该批次可重新写入服务端</span>
      </div>

      <div v-if="r.reason === 'task-conflict' && r.editIds" class="review-actions">
        <button v-for="id in r.editIds" :key="id" type="button" @click="decide(r, id)">
          采用设备 {{ editById.get(id)?.deviceId }} 的版本
        </button>
        <button type="button" class="danger" @click="decide(r, 'reject')">维持基础版本（驳回修改）</button>
      </div>

      <div v-else-if="r.reason !== 'zone-unknown'" class="review-actions">
        <button type="button" @click="decide(r, 'confirm')">确认放行（计划外加车）</button>
        <button type="button" class="danger" @click="decide(r, 'reject')">驳回该笔</button>
      </div>

      <input
        v-model="noteProxy(r).value"
        class="review-note"
        placeholder="核对备注（可选，随结论一起保存）"
      />
    </article>

    <h3>已裁定（{{ resolvedList.length }}）</h3>
    <article v-for="r in resolvedList" :key="r.id" class="review-card resolved">
      <header>
        <span class="badge badge-ok">{{ statusText(r) }}</span>
        <strong>{{ r.title }}</strong>
        <span class="muted">{{ reasonText(r.reason) }}</span>
      </header>
      <p class="review-msg">
        {{ r.message }}
        <template v-if="r.resolution?.note">｜备注：{{ r.resolution.note }}</template>
      </p>
      <div class="review-actions">
        <button type="button" class="secondary" @click="undo(r)">撤销裁定，重新核对</button>
      </div>
    </article>
  </div>
</template>
