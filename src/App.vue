<script setup lang="ts">
import { ref } from "vue";
import { useDispatchStore } from "./store/dispatch";
import DispatchConsole from "./components/DispatchConsole.vue";
import ReviewPanel from "./components/ReviewPanel.vue";
import ExportSummary from "./components/ExportSummary.vue";

const store = useDispatchStore();
const view = ref<"console" | "review" | "export">("console");

const devices = ["调度台-01", "手持终端-07", "手持终端-12"];
const syncTip = ref<string | null>(null);

async function handleSync() {
  const res = await store.syncNow();
  syncTip.value = res.ok
    ? `同步成功：有效与排队记录已入库，冲突与失效记录保留在核对区。`
    : `写入失败：本地批次已保留，可在修正后重试（${res.error}）`;
  setTimeout(() => (syncTip.value = null), 4000);
}

function loadDemo() {
  store.loadDemoScenario();
  view.value = "console";
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">物流调度 · 离线优先</p>
          <h1>离线派车合并台</h1>
          <p class="subtitle">
            按发起时刻仲裁任务版本，同车同班次唯一占用，区域容量排队，冲突留待核对。
          </p>
        </div>
        <div class="top-controls">
          <label class="device-pick">
            当前设备
            <select :value="store.deviceId" @change="store.setDevice(($event.target as HTMLSelectElement).value)">
              <option v-for="device in devices" :key="device" :value="device">{{ device }}</option>
            </select>
          </label>
          <label class="switch-pick">
            <input type="checkbox" v-model="store.failNextWrite" />
            模拟下一次写入失败
          </label>
          <button type="button" class="secondary" @click="loadDemo">装载离线重连演示</button>
          <button type="button" class="danger ghost" @click="store.resetAll()">清空</button>
        </div>
      </header>

      <section class="sync-bar">
        <div class="sync-info">
          <span class="dot" :class="{ ok: store.outbox.length === 0, busy: store.outbox.length > 0 }" />
          <span v-if="store.outbox.length === 0">本地无待写批次</span>
          <span v-else>{{ store.outbox.length }} 个本地批次待同步，共
            {{ store.outbox.reduce((n, b) => n + b.ops.length, 0) }} 笔记录
          </span>
          <span v-if="store.lastSyncAt" class="muted">上次成功同步：{{ new Date(store.lastSyncAt).toLocaleTimeString('zh-CN', { hour12: false }) }}</span>
        </div>
        <div class="sync-actions">
          <button type="button" :disabled="store.syncing || store.outbox.length === 0" @click="handleSync">
            {{ store.syncing ? "同步中…" : "重连并同步 / 失败重试" }}
          </button>
        </div>
      </section>

      <p v-if="syncTip" class="sync-tip" :class="{ error: syncTip.includes('失败') }">{{ syncTip }}</p>

      <nav class="tabs">
        <button :class="{ active: view === 'console' }" type="button" @click="view = 'console'">
          调度台
        </button>
        <button :class="{ active: view === 'review' }" type="button" @click="view = 'review'">
          核对区
          <span v-if="store.mergeResult.reviewItems.length" class="tab-badge">
            {{ store.mergeResult.reviewItems.length }}
          </span>
        </button>
        <button :class="{ active: view === 'export' }" type="button" @click="view = 'export'">
          导出摘要
        </button>
      </nav>

      <DispatchConsole v-if="view === 'console'" />
      <ReviewPanel v-else-if="view === 'review'" />
      <ExportSummary v-else />
    </div>
  </main>
</template>
