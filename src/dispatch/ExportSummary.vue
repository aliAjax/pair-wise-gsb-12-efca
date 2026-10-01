<script setup lang="ts">
import { computed } from "vue";
import { useDispatchStore } from "./store";
import { buildOccupancyCsv, buildReviewCsv, buildTextSummary, download, reasonText } from "./exporter";
import { fmtDateTime } from "./format";

const store = useDispatchStore();
const result = computed(() => store.mergeResult);
const summaryText = computed(() => buildTextSummary(result.value));

const statCards = computed(() => {
  const s = result.value.stats;
  return [
    { label: "派车记录", value: s.totalOps, sub: `派车 ${s.assigns} · 取消 ${s.cancels}` },
    { label: "有效占用", value: s.effective, sub: `人工放行 ${s.manualEffective}` },
    { label: "超容排队", value: s.queued, sub: "先发起先排" },
    { label: "待核对", value: s.pendingReviews, sub: `已裁定 ${s.resolvedReviews}` },
    { label: "作废车班", value: s.cancelledGroups, sub: `被取代 ${s.superseded}` },
    { label: "任务版本争议", value: s.disputedTasks, sub: "同刻不同内容" }
  ];
});

function copySummary(): void {
  navigator.clipboard?.writeText(summaryText.value);
}

function exportOccupancy(): void {
  download(`派车有效占用-${new Date().toISOString().slice(0, 10)}.csv`, buildOccupancyCsv(result.value), "text/csv;charset=utf-8");
}

function exportReviews(): void {
  download(`核对区清单-${new Date().toISOString().slice(0, 10)}.csv`, buildReviewCsv(result.value), "text/csv;charset=utf-8");
}
</script>

<template>
  <div class="exporter">
    <section class="stat-grid">
      <article v-for="c in statCards" :key="c.label" class="stat-card">
        <span>{{ c.label }}</span>
        <strong>{{ c.value }}</strong>
        <em>{{ c.sub }}</em>
      </article>
    </section>

    <section class="panel">
      <div class="toolbar">
        <h2>导出摘要</h2>
        <div class="btn-row">
          <button type="button" @click="copySummary">复制文本摘要</button>
          <button type="button" class="secondary" @click="exportOccupancy">导出有效占用 CSV</button>
          <button type="button" class="secondary" @click="exportReviews">导出核对清单 CSV</button>
        </div>
      </div>
      <pre class="summary-box">{{ summaryText }}</pre>
      <p class="muted small">生成时间 {{ fmtDateTime(result.generatedAt) }}，与调度台、核对区为同一份合并结果。</p>
    </section>

    <section class="panel">
      <h2>作废凭据（取消 / 被新派车取代）</h2>
      <table class="grid-table">
        <thead>
          <tr><th>发起时刻</th><th>记录</th><th>车牌/班次</th><th>司机</th><th>去向</th><th>来源设备</th></tr>
        </thead>
        <tbody>
          <tr v-for="c in result.cancelled" :key="c.id">
            <td>{{ fmtDateTime(c.issuedAt) }}</td>
            <td>{{ c.id }}（取消单）</td>
            <td>{{ c.vehicleId }} {{ c.shift }}</td>
            <td>{{ c.driver }}</td>
            <td><span class="badge badge-danger">整组取消</span></td>
            <td class="muted">{{ c.deviceId }}</td>
          </tr>
          <tr v-for="s in result.superseded" :key="s.op.id">
            <td>{{ fmtDateTime(s.op.issuedAt) }}</td>
            <td>{{ s.op.id }}</td>
            <td>{{ s.op.vehicleId }} {{ s.op.shift }}</td>
            <td>{{ s.op.driver }}</td>
            <td>
              <span :class="s.winnerCancels ? 'badge badge-danger' : 'badge badge-warn'">
                {{ s.winnerCancels ? "被取消单作废" : `被 ${s.byOpId} 取代` }}
              </span>
            </td>
            <td class="muted">{{ s.op.deviceId }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="result.reviews.length" class="panel">
      <h2>核对结论一览</h2>
      <ul class="conclusion-list">
        <li v-for="r in result.reviews" :key="r.id">
          <span :class="r.resolution ? 'badge badge-ok' : 'badge badge-warn'">
            {{ r.resolution ? "已裁定" : "待核对" }}
          </span>
          <span>{{ reasonText(r.reason) }}</span>
          <strong>{{ r.title }}</strong>
        </li>
      </ul>
    </section>
  </div>
</template>
