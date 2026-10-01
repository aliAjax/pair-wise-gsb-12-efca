<script setup lang="ts">
import { computed } from "vue";
import { useDispatchStore } from "./store";
import { fmtDateTime, fmtTime } from "./format";

const store = useDispatchStore();
const result = computed(() => store.mergeResult);

const taskById = computed(() => new Map(result.value.tasks.map((t) => [t.taskId, t])));

function statusText(status: string): string {
  return status === "synced" ? "已写入" : status === "failed" ? "写入失败" : "待上传";
}

function statusClass(status: string): string {
  return status === "synced" ? "ok" : status === "failed" ? "danger" : "warn";
}

function isSyncing(id: string): boolean {
  return store.syncing.has(id);
}

function taskLabel(taskId: string): string {
  const t = taskById.value.get(taskId);
  return t ? `${t.title}(${t.zone})` : `任务 ${taskId} 缺失`;
}
</script>

<template>
  <div class="board">
    <section class="panel sync-panel">
      <div class="sync-row">
        <div class="sync-controls">
          <label class="switch-label">
            <input type="checkbox" v-model="store.online" />
            网络 {{ store.online ? "在线（重连）" : "离线" }}
          </label>
          <label class="switch-label">
            <input type="checkbox" v-model="store.forceFailure" :disabled="!store.online" />
            模拟服务端写入失败
          </label>
        </div>
        <div class="sync-actions">
          <button type="button" :disabled="store.pendingBatches.length === 0" @click="store.syncAll()">
            重连后批量写入（{{ store.pendingBatches.length }}）
          </button>
          <button type="button" class="secondary" @click="store.resetDemo()">恢复演示数据</button>
        </div>
      </div>
      <p v-if="store.notice" class="sync-notice">{{ store.notice }}</p>

      <div class="batch-grid">
        <article v-for="b in store.batches" :key="b.id" class="batch-card" :class="`is-${b.status}`">
          <header>
            <div>
              <strong>批次 {{ b.id }}</strong>
              <span class="muted small">{{ b.deviceId }}</span>
            </div>
            <span class="batch-status" :class="statusClass(b.status)">{{ statusText(b.status) }}</span>
          </header>
          <p class="small muted">
            发起 {{ fmtDateTime(b.createdAt) }}<template v-if="b.uploadedAt"> ｜写入 {{ fmtDateTime(b.uploadedAt) }}</template>
          </p>
          <p class="small">{{ b.ops.length }} 笔派车<template v-if="b.taskEdits.length"> ｜{{ b.taskEdits.length }} 笔任务修改</template></p>
          <p v-if="b.lastError" class="batch-error">{{ b.lastError }}</p>
          <div v-if="b.status !== 'synced'" class="batch-ops">
            <button
              type="button"
              class="small-btn"
              :disabled="isSyncing(b.id) || !store.online"
              @click="store.syncBatch(b.id)"
            >
              {{ isSyncing(b.id) ? "写入中…" : b.status === "failed" ? "修正后重试写入" : "立即写入" }}
            </button>
            <span v-if="!store.online" class="small muted">离线中，写入将保留为本地批次</span>
          </div>
        </article>
      </div>
    </section>

    <section class="panel">
      <h2>有效占用（同一车辆同一班次仅一条，按发起时刻裁决）</h2>
      <div class="table-wrap">
        <table class="grid-table">
          <thead>
            <tr>
              <th>发起时刻</th>
              <th>车牌号</th>
              <th>司机</th>
              <th>区域/班次</th>
              <th>有效任务版本</th>
              <th>来源设备</th>
              <th>放行方式</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in result.effective" :key="o.opId">
              <td>{{ fmtDateTime(o.issuedAt) }}</td>
              <td>{{ o.vehicleId }}</td>
              <td>{{ o.driver }}</td>
              <td>{{ o.zone }} {{ o.shift }}</td>
              <td>
                {{ taskLabel(o.taskId) }}
                <span class="muted small">引用 v{{ o.taskVersion }}</span>
              </td>
              <td class="muted">{{ o.deviceId }}</td>
              <td>
                <span :class="o.manual ? 'badge badge-warn' : 'badge badge-ok'">
                  {{ o.manual ? "人工放行" : "自动生效" }}
                </span>
              </td>
            </tr>
            <tr v-if="result.effective.length === 0">
              <td colspan="7" class="empty-box">暂无有效占用</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="two-col">
      <div class="panel">
        <h2>区域容量排队</h2>
        <table class="grid-table">
          <thead>
            <tr><th>区域</th><th>班次</th><th>占用/容量</th><th>排队</th><th>状态</th></tr>
          </thead>
          <tbody>
            <tr v-for="u in result.zoneUsage" :key="u.zone + u.shift">
              <td>{{ u.zone }}</td>
              <td>{{ u.shift }}</td>
              <td>{{ u.used }}/{{ u.capacity || "未配置" }}</td>
              <td>{{ u.queued }}</td>
              <td>
                <span v-if="u.capacity === 0" class="badge badge-danger">容量未知·待核对</span>
                <span v-else-if="u.queued > 0" class="badge badge-warn">超容排队</span>
                <span v-else class="badge badge-ok">正常</span>
              </td>
            </tr>
          </tbody>
        </table>

        <h3 v-if="result.queued.length" class="queue-title">排队明细（先发起先排）</h3>
        <ul v-if="result.queued.length" class="queue-list">
          <li v-for="q in result.queued" :key="q.opId">
            <span class="muted">{{ fmtTime(q.issuedAt) }}</span>
            {{ q.vehicleId }} / {{ q.driver }} / {{ q.zone }}{{ q.shift }}
            <span class="badge badge-warn">第 {{ q.queueRank }} 位（容量 {{ q.capacity }}）</span>
          </li>
        </ul>
      </div>

      <div class="panel">
        <h2>任务有效版本（按发起时刻，非上传顺序）</h2>
        <table class="grid-table">
          <thead>
            <tr><th>任务</th><th>名称</th><th>区域</th><th>版本</th><th>生效来源</th></tr>
          </thead>
          <tbody>
            <tr v-for="t in result.tasks" :key="t.taskId">
              <td>{{ t.taskId }}</td>
              <td>{{ t.title }}</td>
              <td>{{ t.zone }}</td>
              <td>v{{ t.version }}</td>
              <td>
                <span v-if="t.disputed" class="badge badge-danger">同刻冲突·暂用基础版</span>
                <span v-else-if="t.issuedAt" class="muted small">{{ t.deviceId }} · {{ fmtTime(t.issuedAt) }}</span>
                <span v-else class="muted small">基础版本</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
