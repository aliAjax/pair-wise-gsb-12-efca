import type {
  BaseTask,
  DispatchOp,
  EffectiveOccupancy,
  EffectiveTaskVersion,
  MergeInput,
  MergeResult,
  QueueEntry,
  ReviewItem,
  ReviewReason,
  SupersededOp,
  TaskEdit,
  ZoneUsage
} from "./types";

/** 同一车辆同一班次只保留一条有效占用，以此为去重键 */
export function vehicleShiftKey(vehicleId: string, shift: string): string {
  return `${vehicleId}|${shift}`;
}

export function zoneShiftKey(zone: string, shift: string): string {
  return `${zone}|${shift}`;
}

/** 发起时刻先后 + 稳定 id，作为全部冲突判定的唯一排序（与上传顺序无关） */
function issuedFirst<T extends { issuedAt: string; id: string }>(a: T, b: T): number {
  const t = a.issuedAt.localeCompare(b.issuedAt);
  return t !== 0 ? t : a.id.localeCompare(b.id);
}

/** 占用对象以 opId 为稳定键 */
function occFirst(
  a: { issuedAt: string; opId: string },
  b: { issuedAt: string; opId: string }
): number {
  const t = a.issuedAt.localeCompare(b.issuedAt);
  return t !== 0 ? t : a.opId.localeCompare(b.opId);
}

function reviewKey(reason: ReviewReason, parts: Array<string | undefined>): string {
  return `${reason}:${parts.filter(Boolean).join("|")}`;
}

interface TaskResolution {
  versions: Map<string, EffectiveTaskVersion>;
  reviews: ReviewItem[];
}

/**
 * 任务版本合并：同一任务被多设备修改时，按发起时刻取最新版本，
 * 不能只看上传/到达顺序。同一发起时刻且内容不一致 → 无法判定，
 * 回退基础版本并进入核对区；人工可在核对区裁定采用某台设备的修改。
 */
function resolveTaskVersions(
  input: MergeInput,
  resolutions: Map<string, ReviewItem["resolution"]>
): TaskResolution {
  const reviews: ReviewItem[] = [];
  const versions = new Map<string, EffectiveTaskVersion>();

  for (const base of input.baseTasks) {
    versions.set(base.id, {
      taskId: base.id,
      title: base.title,
      zone: base.zone,
      version: base.version,
      disputed: false
    });
  }

  const editsByTask = new Map<string, TaskEdit[]>();
  for (const edit of input.taskEdits) {
    const list = editsByTask.get(edit.taskId) ?? [];
    list.push(edit);
    editsByTask.set(edit.taskId, list);
  }

  const applyEdit = (base: BaseTask, edit: TaskEdit, disputed: boolean): EffectiveTaskVersion => ({
    taskId: base.id,
    title: edit.title ?? base.title,
    zone: edit.zone ?? base.zone,
    version: Math.max(base.version, edit.baseVersion) + 1,
    issuedAt: edit.issuedAt,
    deviceId: edit.deviceId,
    disputed
  });

  for (const [taskId, edits] of editsByTask) {
    const base = input.baseTasks.find((t) => t.id === taskId);
    if (!base) {
      edits.sort(issuedFirst);
      reviews.push({
        id: reviewKey("task-missing", [taskId]),
        reason: "task-missing",
        title: `任务「${taskId}」不存在`,
        message: `有 ${edits.length} 条修改指向台账中不存在的任务，无法合并，请核对任务编号。`,
        editIds: edits.map((e) => e.id),
        taskId,
        issuedAt: edits[edits.length - 1].issuedAt
      });
      continue;
    }

    edits.sort(issuedFirst);
    const latestAt = edits[edits.length - 1].issuedAt;
    const newest = edits.filter((e) => e.issuedAt === latestAt);
    const samePayload = newest.every(
      (e) =>
        (e.title ?? base.title) === (newest[0].title ?? base.title) &&
        (e.zone ?? base.zone) === (newest[0].zone ?? base.zone)
    );

    if (newest.length > 1 && !samePayload) {
      const rid = reviewKey("task-conflict", [taskId, latestAt]);
      const resolution = resolutions.get(rid);
      const chosen =
        resolution && resolution.action !== "reject"
          ? newest.find((e) => e.id === resolution.action)
          : undefined;

      if (chosen) {
        // 人工裁定采用某台设备同刻提交的版本
        versions.set(taskId, applyEdit(base, chosen, false));
        reviews.push({
          id: rid,
          reason: "task-conflict",
          title: `任务「${base.title}」同刻冲突（已裁定）`,
          message: `${newest.length} 台设备在 ${latestAt} 同刻修改且内容不一致，已按人工裁定采用设备 ${chosen.deviceId} 的版本。`,
          editIds: newest.map((e) => e.id),
          taskId,
          issuedAt: latestAt,
          resolution
        });
      } else {
        versions.set(taskId, {
          taskId: base.id,
          title: base.title,
          zone: base.zone,
          version: base.version,
          disputed: true
        });
        reviews.push({
          id: rid,
          reason: "task-conflict",
          title: `任务「${base.title}」同刻冲突`,
          message: `${newest.length} 台设备在 ${latestAt} 同时修改该任务且内容不一致，无法判定先后，暂按基础版本（v${base.version}）执行，请人工裁定。`,
          editIds: newest.map((e) => e.id),
          taskId,
          issuedAt: latestAt,
          resolution: resolution?.action === "reject" ? resolution : undefined
        });
      }
      continue;
    }

    versions.set(taskId, applyEdit(base, newest[0], false));
  }

  return { versions, reviews };
}

interface VehicleGroup {
  key: string;
  vehicleId: string;
  shift: DispatchOp["shift"];
  ops: DispatchOp[]; // 已按发起时刻排序
}

interface OccupancyResolution {
  effective: EffectiveOccupancy[];
  cancelled: DispatchOp[];
  superseded: SupersededOp[];
  groups: VehicleGroup[];
}

/**
 * 车辆占用合并：同一车辆同一班次只留一条有效占用。
 * 按发起时刻判定先后（不看上传顺序）；最晚一笔为取消则整组取消，
 * 否则最晚派车为有效占用，更早的派车记为被取代。
 */
function resolveVehicleOccupancy(ops: DispatchOp[]): OccupancyResolution {
  const groupsMap = new Map<string, VehicleGroup>();
  for (const op of ops) {
    const key = vehicleShiftKey(op.vehicleId, op.shift);
    const group = groupsMap.get(key) ?? { key, vehicleId: op.vehicleId, shift: op.shift, ops: [] };
    group.ops.push(op);
    groupsMap.set(key, group);
  }

  const effective: EffectiveOccupancy[] = [];
  const cancelled: DispatchOp[] = [];
  const superseded: SupersededOp[] = [];
  const groups = [...groupsMap.values()];

  for (const group of groups) {
    group.ops.sort(issuedFirst);
    const winner = group.ops[group.ops.length - 1];

    if (winner.action === "cancel") {
      // 最晚发起的是取消：此前派车全部作废，取消单本身作为凭据留存
      for (const op of group.ops) {
        if (op.id === winner.id) cancelled.push(op);
        else superseded.push({ op, byOpId: winner.id, winnerCancels: true });
      }
      continue;
    }

    effective.push(toOccupancy(winner, false));
    for (const op of group.ops.slice(0, -1)) {
      superseded.push({ op, byOpId: winner.id, winnerCancels: false });
    }
  }

  effective.sort(occFirst);
  cancelled.sort(issuedFirst);
  superseded.sort((a, b) => issuedFirst(a.op, b.op));
  return { effective, cancelled, superseded, groups };
}

function toOccupancy(op: DispatchOp, manual: boolean): EffectiveOccupancy {
  return {
    opId: op.id,
    vehicleId: op.vehicleId,
    driver: op.driver,
    zone: op.zone,
    shift: op.shift,
    taskId: op.taskId,
    taskVersion: op.taskVersion,
    deviceId: op.deviceId,
    issuedAt: op.issuedAt,
    manual
  };
}

export interface MergeOptions {
  /** 已持久化的人工核对结论，key 为 reviewId；纯函数据此复算同一结果 */
  resolutions?: Map<string, ReviewItem["resolution"]>;
}

/**
 * 离线调度合并入口。调度台、核对区、导出摘要共用同一份 MergeResult。
 */
export function mergeDispatch(input: MergeInput, options: MergeOptions = {}): MergeResult {
  const resolutions = options.resolutions ?? new Map();

  const taskResolution = resolveTaskVersions(input, resolutions);
  const tasks = [...taskResolution.versions.values()].sort((a, b) =>
    a.taskId.localeCompare(b.taskId)
  );
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));

  const occupancy = resolveVehicleOccupancy(input.ops);

  const reviews: ReviewItem[] = [...taskResolution.reviews];
  const opById = new Map(input.ops.map((op) => [op.id, op]));

  // —— 第一层：有效占用的任务版本校验 ——
  const admitted: EffectiveOccupancy[] = [];
  for (const occ of occupancy.effective) {
    const task = taskById.get(occ.taskId);
    if (!task) {
      reviews.push({
        id: reviewKey("task-missing", [occ.taskId, "op", occ.opId]),
        reason: "task-missing",
        title: `车辆 ${occ.vehicleId} 引用了不存在的任务`,
        message: `派车记录引用任务 ${occ.taskId}，台账中无此任务，占用暂不生效，请核对。`,
        opIds: [occ.opId],
        taskId: occ.taskId,
        zone: occ.zone,
        shift: occ.shift,
        vehicleId: occ.vehicleId,
        driver: occ.driver,
        issuedAt: occ.issuedAt
      });
      continue;
    }
    if (occ.taskVersion < task.version && occ.zone !== task.zone) {
      // 引用旧任务版本且有效版本的区域已变：不能直接占用
      reviews.push({
        id: reviewKey("stale-task", [occ.opId]),
        reason: "stale-task",
        title: `车辆 ${occ.vehicleId} 使用了过期任务版本`,
        message: `派车基于任务 v${occ.taskVersion}（区域 ${occ.zone}），有效版本为 v${task.version}（区域 ${task.zone}），占用暂不生效，请改按最新任务重派或由人工确认放行。`,
        opIds: [occ.opId],
        taskId: occ.taskId,
        zone: occ.zone,
        shift: occ.shift,
        vehicleId: occ.vehicleId,
        driver: occ.driver,
        issuedAt: occ.issuedAt
      });
      continue;
    }
    admitted.push(occ);
  }

  // —— 第二层：同一司机同一班次只能占一辆车，发起最早者优先 ——
  admitted.sort(occFirst);
  const driverSeen = new Map<string, EffectiveOccupancy>();
  const afterDriver: EffectiveOccupancy[] = [];
  for (const occ of admitted) {
    const dk = `${occ.driver}|${occ.shift}`;
    const keeper = driverSeen.get(dk);
    if (keeper) {
      reviews.push({
        id: reviewKey("driver-double", [occ.driver, occ.shift, occ.opId]),
        reason: "driver-double",
        title: `司机 ${occ.driver} ${occ.shift}被多车占用`,
        message: `该司机${occ.shift}已先分配车辆 ${keeper.vehicleId}（${keeper.issuedAt} 发起），车辆 ${occ.vehicleId} 的派车暂不生效；请改派司机或由人工确认。`,
        opIds: [occ.opId, keeper.opId],
        zone: occ.zone,
        shift: occ.shift,
        vehicleId: occ.vehicleId,
        driver: occ.driver,
        issuedAt: occ.issuedAt
      });
      continue;
    }
    driverSeen.set(dk, occ);
    afterDriver.push(occ);
  }

  // —— 第三层：区域容量排队（按区域-班次，发起时刻先到先得） ——
  const zoneBuckets = new Map<string, EffectiveOccupancy[]>();
  for (const occ of afterDriver) {
    const key = zoneShiftKey(occ.zone, occ.shift);
    const bucket = zoneBuckets.get(key) ?? [];
    bucket.push(occ);
    zoneBuckets.set(key, bucket);
  }

  const effective: EffectiveOccupancy[] = [];
  const queued: QueueEntry[] = [];
  const queuedIds = new Set<string>();

  for (const [key, bucket] of zoneBuckets) {
    const [zone, shift] = key.split("|") as [string, DispatchOp["shift"]];
    const capacity = input.capacities[key];
    if (capacity === undefined) {
      // 区域未配置容量：无法判定，全部留待核对
      for (const occ of bucket) {
        reviews.push({
          id: reviewKey("zone-unknown", [zone, shift, occ.opId]),
          reason: "zone-unknown",
          title: `区域「${zone}」${shift} 未配置容量`,
          message: `无法判断车辆 ${occ.vehicleId} 的派车是否超容，暂不生效，请先补齐区域容量。`,
          opIds: [occ.opId],
          zone,
          shift,
          vehicleId: occ.vehicleId,
          driver: occ.driver,
          issuedAt: occ.issuedAt
        });
      }
      continue;
    }

    bucket.forEach((occ, index) => {
      if (index < capacity) {
        effective.push(occ);
      } else {
        const rid = reviewKey("zone-overflow", [zone, shift, occ.opId]);
        queuedIds.add(occ.opId);
        queued.push({
          ...occ,
          reviewId: rid,
          queueRank: index + 1,
          capacity
        });
        reviews.push({
          id: rid,
          reason: "zone-overflow",
          title: `区域「${zone}」${shift} 超出容量`,
          message: `该区域${shift}容量 ${capacity} 辆，本笔排队第 ${index + 1} 位；可在核对区确认放行（计划外加车）或驳回。`,
          opIds: [occ.opId],
          zone,
          shift,
          vehicleId: occ.vehicleId,
          driver: occ.driver,
          issuedAt: occ.issuedAt
        });
      }
    });
  }

  // —— 应用人工核对结论 ——
  const reviewById = new Map<string, ReviewItem>();
  for (const item of reviews) {
    const saved = resolutions.get(item.id);
    reviewById.set(item.id, saved ? { ...item, resolution: saved } : item);
  }

  const manualReadd: Array<{ review: ReviewItem; occ: EffectiveOccupancy }> = [];
  for (const item of reviewById.values()) {
    if (!item.resolution) continue;
    const op = item.opIds ? opById.get(item.opIds[0]) : undefined;

    if (item.resolution.action === "confirm" && op) {
      if (item.reason === "zone-overflow") {
        const qi = queued.findIndex((q) => q.opId === op.id);
        if (qi >= 0) {
          const q = queued[qi];
          queued.splice(qi, 1);
          queuedIds.delete(op.id);
          manualReadd.push({ review: item, occ: toOccupancy(op, true) });
        }
      } else if (
        item.reason === "driver-double" ||
        item.reason === "stale-task" ||
        item.reason === "task-missing" ||
        item.reason === "zone-unknown"
      ) {
        manualReadd.push({ review: item, occ: toOccupancy(op, true) });
      }
    }
  }

  // 人工放行仍需通过"司机不重复"这一硬约束；冲突的放行不静默生效，回到待核对
  const finalEffective = [...effective];
  const occupiedDriver = new Set(finalEffective.map((o) => `${o.driver}|${o.shift}`));
  const occupiedVS = new Set(finalEffective.map((o) => vehicleShiftKey(o.vehicleId, o.shift)));
  manualReadd.sort((a, b) => occFirst(a.occ, b.occ));
  for (const { review, occ } of manualReadd) {
    const dk = `${occ.driver}|${occ.shift}`;
    const vk = vehicleShiftKey(occ.vehicleId, occ.shift);
    if (occupiedDriver.has(dk) || occupiedVS.has(vk)) {
      review.resolution = undefined;
      reviewById.set(review.id, review);
      continue;
    }
    occupiedDriver.add(dk);
    occupiedVS.add(vk);
    finalEffective.push(occ);
  }

  finalEffective.sort(occFirst);
  queued.sort(occFirst);

  // —— 区域用量汇总 ——
  const zoneUsageMap = new Map<string, ZoneUsage>();
  const ensureUsage = (zone: string, shift: DispatchOp["shift"]): ZoneUsage => {
    const key = zoneShiftKey(zone, shift);
    let usage = zoneUsageMap.get(key);
    if (!usage) {
      usage = { zone, shift, capacity: input.capacities[key] ?? 0, used: 0, queued: 0 };
      zoneUsageMap.set(key, usage);
    }
    return usage;
  };
  for (const occ of finalEffective) ensureUsage(occ.zone, occ.shift).used += 1;
  for (const q of queued) ensureUsage(q.zone, q.shift).queued += 1;

  // —— 统计 ——
  const allReviews = [...reviewById.values()].sort(issuedFirst);
  const stats: MergeResult["stats"] = {
    totalOps: input.ops.length,
    assigns: input.ops.filter((op) => op.action === "assign").length,
    cancels: input.ops.filter((op) => op.action === "cancel").length,
    effective: finalEffective.length,
    manualEffective: finalEffective.filter((o) => o.manual).length,
    queued: queued.length,
    pendingReviews: allReviews.filter((r) => !r.resolution).length,
    resolvedReviews: allReviews.filter((r) => Boolean(r.resolution)).length,
    cancelledGroups: new Set(
      occupancy.cancelled.map((op) => vehicleShiftKey(op.vehicleId, op.shift))
    ).size,
    superseded: occupancy.superseded.filter((s) => !s.winnerCancels).length,
    disputedTasks: tasks.filter((t) => t.disputed).length
  };

  return {
    generatedAt: new Date().toISOString(),
    effective: finalEffective,
    queued,
    reviews: allReviews,
    tasks,
    zoneUsage: [...zoneUsageMap.values()].sort((a, b) =>
      (a.zone + a.shift).localeCompare(b.zone + b.shift)
    ),
    cancelled: occupancy.cancelled,
    superseded: occupancy.superseded,
    stats
  };
}
