<script setup lang="ts">
import { computed, ref } from "vue";
import { useDispatchStore } from "./dispatch/store";
import DispatchBoard from "./dispatch/DispatchBoard.vue";
import ReviewPanel from "./dispatch/ReviewPanel.vue";
import ExportSummary from "./dispatch/ExportSummary.vue";

const store = useDispatchStore();

const tabs = [
  { key: "board", label: "调度台", component: DispatchBoard },
  { key: "review", label: "核对区", component: ReviewPanel },
  { key: "export", label: "导出摘要", component: ExportSummary }
] as const;

const active = ref<(typeof tabs)[number]["key"]>("board");
const current = computed(() => tabs.find((t) => t.key === active.value)!.component);

const pendingCount = computed(() => store.mergeResult.stats.pendingReviews);
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">物流 · 离线调度合并</p>
          <h1>车辆离线派车合并台</h1>
          <p class="subtitle">
            调度员离线派车，重连后按<strong>发起时刻</strong>合并：同一车辆同一班次只留一条有效占用，
            按区域容量排队，无法判定的冲突留待核对。调度台、核对区、导出摘要共用同一份合并结果。
          </p>
        </div>
        <div class="stack">
          <span class="tag">Vue3</span>
          <span class="tag">Pinia</span>
          <span class="tag">TypeScript</span>
          <span class="tag">本地批次持久化</span>
        </div>
      </header>

      <nav class="tabs">
        <button
          v-for="t in tabs"
          :key="t.key"
          type="button"
          class="tab"
          :class="{ active: active === t.key }"
          @click="active = t.key"
        >
          {{ t.label }}
          <span v-if="t.key === 'review' && pendingCount > 0" class="tab-dot">{{ pendingCount }}</span>
        </button>
      </nav>

      <component :is="current" />
    </div>
  </main>
</template>
