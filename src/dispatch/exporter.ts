import type { MergeResult, ReviewItem } from "./types";

const REASON_TEXT: Record<string, string> = {
  "driver-double": "司机重复占用",
  "zone-overflow": "区域超容排队",
  "zone-unknown": "区域容量未知",
  "stale-task": "任务版本过期",
  "task-missing": "任务不存在",
  "task-conflict": "任务同刻冲突"
};

export function reasonText(reason: ReviewItem["reason"]): string {
  return REASON_TEXT[reason] ?? reason;
}

export function buildTextSummary(result: MergeResult): string {
  const s = result.stats;
  const lines = [
    "离线派车合并摘要",
    `生成时间：${result.generatedAt}`,
    "=".repeat(34),
    `派车记录合计：${s.totalOps}（派车 ${s.assigns} / 取消 ${s.cancels}）`,
    `有效占用：${s.effective}（其中人工放行 ${s.manualEffective}）`,
    `超容排队：${s.queued}`,
    `取消作废的车班：${s.cancelledGroups}；被新派车取代：${s.superseded}`,
    `任务版本存争议：${s.disputedTasks}`,
    `核对项：待处理 ${s.pendingReviews} / 已裁定 ${s.resolvedReviews}`,
    "",
    "【有效占用】"
  ];

  for (const o of result.effective) {
    lines.push(
      `${o.issuedAt}  ${o.vehicleId}  ${o.driver}  ${o.zone} ${o.shift}  任务 ${o.taskId}(v${o.taskVersion})${o.manual ? "  [人工放行]" : ""}`
    );
  }

  if (result.queued.length) {
    lines.push("", "【超容排队】");
    for (const q of result.queued) {
      lines.push(
        `${q.issuedAt}  ${q.vehicleId}  ${q.driver}  ${q.zone} ${q.shift}  排队第 ${q.queueRank}/${q.capacity}`
      );
    }
  }

  lines.push("", "【区域用量】");
  for (const u of result.zoneUsage) {
    lines.push(
      `${u.zone} ${u.shift}：占用 ${u.used}/${u.capacity || "?"}${u.queued ? `，排队 ${u.queued}` : ""}`
    );
  }

  lines.push("", "【任务有效版本】");
  for (const t of result.tasks) {
    lines.push(
      `${t.taskId} v${t.version}  ${t.title}  区域 ${t.zone}` +
        `${t.disputed ? "  [同刻冲突，暂用基础版本]" : t.issuedAt ? `  生效于 ${t.issuedAt}（${t.deviceId}）` : "  （基础版本）"}`
    );
  }

  lines.push("", "【核对区】");
  for (const r of result.reviews) {
    lines.push(
      `[${r.resolution ? "已" + (r.resolution.action === "reject" ? "驳回" : r.reason === "task-conflict" ? "裁定" : "放行") : "待核对"}] ` +
        `${reasonText(r.reason)}  ${r.title}  发起 ${r.issuedAt}` +
        (r.resolution?.note ? `  备注：${r.resolution.note}` : "")
    );
  }

  return lines.join("\n");
}

function csvCell(value: string | number): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Array<Array<string | number>>): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

export function buildOccupancyCsv(result: MergeResult): string {
  return "﻿" + toCsv([
    ["发起时刻", "车牌号", "司机", "区域", "班次", "任务", "任务版本", "来源设备", "是否人工放行"],
    ...result.effective.map((o) => [
      o.issuedAt,
      o.vehicleId,
      o.driver,
      o.zone,
      o.shift,
      o.taskId,
      o.taskVersion,
      o.deviceId,
      o.manual ? "是" : "否"
    ])
  ]);
}

export function buildReviewCsv(result: MergeResult): string {
  return "﻿" + toCsv([
    ["类型", "标题", "说明", "发起时刻", "区域", "班次", "车牌", "司机", "状态"],
    ...result.reviews.map((r) => [
      reasonText(r.reason),
      r.title,
      r.message,
      r.issuedAt,
      r.zone ?? "",
      r.shift ?? "",
      r.vehicleId ?? "",
      r.driver ?? "",
      r.resolution ? "已裁定" : "待核对"
    ])
  ]);
}

export function download(filename: string, content: string, mime = "text/plain;charset=utf-8"): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
