<script setup lang="ts">
import { computed } from "vue";
import { useDispatchStore } from "../store/dispatch";

const store = useDispatchStore();
const result = computed(() => store.mergeResult);

function fmt(ts: number) {
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

function buildCsv(): string {
  const header = [
    "状态",
    "类型",
    "发起时刻",
    "上传时刻",
    "班次",
    "车牌",
    "司机",
    "区域",
    "任务编号",
    "有效任务版本",
    "版本号",
    "来源设备",
    "是否已确认",
    "判定原因"
  ];
  const esc = (value: string | number | undefined | null) => {
    const s = String(value ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const statusMap: Record<string, string> = {
    accepted: "有效",
    queued: "排队",
    review: "待核对",
    superseded: "已失效"
  };
  const rows = result.value.items.map((item) =>
    [
      statusMap[item.status],
      item.op.type === "assign" ? "派车" : "编辑",
      fmt(item.op.issuedAt),
      fmt(item.op.uploadedAt),
      item.op.shift,
      item.op.vehicle,
      item.op.driver,
      item.op.zone,
      item.op.taskId,
      item.effectiveTaskTitle,
      item.effectiveTaskVersion,
      item.op.deviceId,
      item.committed ? "是" : "否",
      item.reason
    ]
      .map(esc)
      .join(",")
  );
  return [header.join(","), ...rows].join("\n");
}

function download(filename: string, content: string, mime: string) {
  const blob = new Blob(["﻿" + content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportCsv() {
  download(`离线派车合并结果-${result.value.summary.generatedAt}.csv`, buildCsv(), "text/csv;charset=utf-8");
}

function exportSummary() {
  const s = result.value.summary;
  const lines = [
    "离线派车合并摘要",
    `生成时刻：${fmt(s.generatedAt)}`,
    `涉及批次：${s.batchCount}`,
    `记录合计：${s.totalOps}`,
    `有效：${s.accepted}　排队：${s.queued}　待核对：${s.review}　已失效：${s.superseded}`,
    "",
    "区域统计：",
    ...result.value.zones.map(
      (zone) =>
        `- ${zone.zone}：有效 ${zone.active}/${zone.capacity}，排队 ${zone.queued}/${zone.queueLimit}` +
        (zone.review ? `，待核对 ${zone.review}` : "")
    ),
    "",
    "有效占用：",
    ...result.value.vehicleOccupancy.map(
      (occ) =>
        `- ${occ.vehicle} / ${occ.driver} → ${occ.zone}（${occ.shift}，发起 ${fmt(occ.issuedAt)}）`
    ),
    "",
    result.value.reviewItems.length
      ? `待核对 ${result.value.reviewItems.length} 笔，请在核对区处理后再同步。`
      : "无待核对冲突。"
  ];
  download(`离线派车摘要-${result.value.summary.generatedAt}.txt`, lines.join("\n"), "text/plain;charset=utf-8");
}
</script>

<template>
  <div class="export-panel">
    <section class="panel">
      <div class="summary-head">
        <h2>导出摘要 <small>与调度台、核对区共用同一份合并结果</small></h2>
        <div class="summary-actions">
          <button type="button" @click="exportCsv">导出明细 CSV</button>
          <button type="button" class="secondary" @click="exportSummary">导出摘要 TXT</button>
        </div>
      </div>

      <div class="summary-cards">
        <div class="summary-card accepted">
          <span>有效</span>
          <strong>{{ result.summary.accepted }}</strong>
        </div>
        <div class="summary-card queued">
          <span>排队</span>
          <strong>{{ result.summary.queued }}</strong>
        </div>
        <div class="summary-card review">
          <span>待核对</span>
          <strong>{{ result.summary.review }}</strong>
        </div>
        <div class="summary-card superseded">
          <span>已失效</span>
          <strong>{{ result.summary.superseded }}</strong>
        </div>
        <div class="summary-card total">
          <span>合计 / 批次</span>
          <strong>{{ result.summary.totalOps }} / {{ result.summary.batchCount }}</strong>
        </div>
      </div>

      <p class="muted">结果生成时刻：{{ fmt(result.summary.generatedAt) }}</p>
    </section>

    <section class="panel">
      <h2>区域排队概览</h2>
      <table class="zone-table">
        <thead>
          <tr>
            <th>区域</th>
            <th>有效占用</th>
            <th>排队中</th>
            <th>待核对</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="zone in result.zones" :key="zone.zone">
            <td>{{ zone.zone }}</td>
            <td>{{ zone.active }} / {{ zone.capacity }}</td>
            <td>{{ zone.queued }} / {{ zone.queueLimit }}</td>
            <td :class="{ warn: zone.review > 0 }">{{ zone.review }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>
