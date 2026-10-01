import type {
  DispatchOp,
  MergeItem,
  MergeResult,
  MergeStatus,
  OutboxBatch,
  VehicleOccupancy,
  ZoneConfig,
  ZoneMergeStat
} from "../types";

const STATUS_RANK: Record<MergeStatus, number> = {
  review: 0,
  accepted: 1,
  queued: 2,
  superseded: 3
};

interface TaskArbitration {
  /** 该任务当前有效标题与版本 */
  title: string;
  version: number;
  /** 仲裁中撞车（同发起时刻、同版本、内容不一致）的记录 id，需核对 */
  conflictIds: Set<string>;
  /** 被判负的编辑记录 id */
  staleEditIds: Set<string>;
  /** 判负原因 */
  staleReason: Map<string, string>;
  /** 有效编辑/派车记录 id（承载有效版本的那条） */
  winnerId: string;
}

/** 派车签名，用于同刻同内容的幂等去重 */
function assignSignature(op: DispatchOp) {
  return [op.vehicle, op.driver, op.zone, op.taskId, op.taskTitle, op.taskVersion].join("|");
}

/**
 * 按发起时刻仲裁任务版本（不看上传顺序）。
 * 排序键：issuedAt 降序 → taskVersion 降序；上传时刻只在完全同刻同内容时兜底。
 */
function arbitrateTasks(ops: DispatchOp[]): Map<string, TaskArbitration> {
  const result = new Map<string, TaskArbitration>();
  const byTask = new Map<string, DispatchOp[]>();
  for (const op of ops) {
    const list = byTask.get(op.taskId) ?? [];
    list.push(op);
    byTask.set(op.taskId, list);
  }

  for (const [taskId, list] of byTask) {
    const staleReason = new Map<string, string>();
    const staleEditIds = new Set<string>();
    const conflictIds = new Set<string>();

    // 仅编辑记录之间决定「有效版本」；派车记录携带任务基线
    const edits = list.filter((op) => op.type === "editTask");
    const ordered = [...list].sort((a, b) => {
      if (b.issuedAt !== a.issuedAt) return b.issuedAt - a.issuedAt;
      if (b.taskVersion !== a.taskVersion) return b.taskVersion - a.taskVersion;
      return a.uploadedAt - b.uploadedAt;
    });

    const baseline = ordered[0];
    let winner = baseline;

    if (edits.length > 0) {
      const topIssued = Math.max(...edits.map((op) => op.issuedAt));
      const topVersion = Math.max(
        ...edits.filter((op) => op.issuedAt === topIssued).map((op) => op.taskVersion)
      );
      const top = edits.filter(
        (op) => op.issuedAt === topIssued && op.taskVersion === topVersion
      );
      const distinctTitles = new Set(top.map((op) => op.taskTitle));

      if (distinctTitles.size > 1) {
        // 不同设备同刻改同一任务且版本号相同、内容不一致：无法判定先后
        for (const op of top) conflictIds.add(op.id);
        const prev = ordered.find((op) => !conflictIds.has(op.id));
        winner = prev ?? baseline;
      } else {
        winner = [...top].sort((a, b) => a.uploadedAt - b.uploadedAt)[0];
        for (const op of top) {
          if (op.id !== winner.id) {
            staleEditIds.add(op.id);
            staleReason.set(op.id, "同刻同版本重复编辑，已去重");
          }
        }
      }

      for (const op of edits) {
        if (conflictIds.has(op.id) || staleEditIds.has(op.id) || op.id === winner.id) continue;
        staleEditIds.add(op.id);
        staleReason.set(op.id, "该任务已取发起时刻更新的有效版本");
      }
    }

    result.set(taskId, {
      title: winner.taskTitle,
      version: winner.taskVersion,
      conflictIds,
      staleEditIds,
      staleReason,
      winnerId: winner.id
    });
  }
  return result;
}

export interface MergeInput {
  /** 上一次已确认同步的派车记录 */
  committed: DispatchOp[];
  /** 重连后各设备待上传 / 重试中的本地批次 */
  batches: OutboxBatch[];
  zones: ZoneConfig[];
  /** 结果生成时刻，默认当前时间 */
  now?: number;
}

/**
 * 离线调度合并主入口。纯函数，便于单测和三端（调度台 / 核对区 / 导出）共用。
 */
export function mergeDispatch(input: MergeInput): MergeResult {
  const { committed, batches, zones } = input;
  const now = input.now ?? Date.now();
  const zoneMap = new Map(zones.map((zone) => [zone.zone, zone]));

  // ---- 1. 批次按幂等键展开，同 id 记录重试只算一次 ----
  const incoming: DispatchOp[] = [];
  /** 同 id 但内容不一致的双方记录，都需核对 */
  const idConflictOps = new Map<string, DispatchOp[]>();
  const seenIncoming = new Map<string, DispatchOp>();
  for (const batch of batches) {
    for (const op of batch.ops) {
      const prev = seenIncoming.get(op.id);
      if (prev) {
        if (assignSignature(prev) !== assignSignature(op) || prev.type !== op.type) {
          const both = idConflictOps.get(op.id) ?? [prev];
          if (!idConflictOps.has(op.id)) idConflictOps.set(op.id, both);
          both.push(op);
        }
        continue;
      }
      seenIncoming.set(op.id, op);
      incoming.push(op);
    }
  }

  const idConflictIds = new Set<string>(idConflictOps.keys());

  /** 已确认对象按引用标记，同 id 的重试副本不会串 */
  const committedRefs = new Set<DispatchOp>(committed);
  const isCommitted = (op: DispatchOp) => committedRefs.has(op);

  // 已确认记录 + 去重后的新记录构成合并全集
  const allOps: DispatchOp[] = [...committed];
  /** 重试批次与已确认内容不一致：参与仲裁展示，但不参与占用竞争 */
  const retryMismatchOps: DispatchOp[] = [];
  const retryMismatchRefs = new Set<DispatchOp>();
  for (const op of incoming) {
    const confirmed = committed.find((item) => item.id === op.id);
    if (!confirmed) {
      allOps.push(op);
      continue;
    }
    if (assignSignature(op) !== assignSignature(confirmed) || op.type !== confirmed.type) {
      retryMismatchOps.push(op);
      retryMismatchRefs.add(op);
      allOps.push(op);
    }
  }

  // ---- 2. 任务版本仲裁：按发起时刻取有效版本 ----
  const taskArbitration = arbitrateTasks(allOps);

  // ---- 3. 同任务改派：同一班次内最新派车取代较早派车 ----
  const taskReassignStale = new Set<string>();
  const assigns = allOps.filter((op) => op.type === "assign");
  const byTaskAssign = new Map<string, DispatchOp[]>();
  for (const op of assigns) {
    const list = byTaskAssign.get(`${op.taskId}::${op.shift}`) ?? [];
    list.push(op);
    byTaskAssign.set(`${op.taskId}::${op.shift}`, list);
  }
  for (const list of byTaskAssign.values()) {
    if (list.length < 2) continue;
    const top = Math.max(...list.map((op) => op.issuedAt));
    const winners = list.filter((op) => op.issuedAt === top);
    const sameWinner =
      new Set(winners.map(assignSignature)).size === 1 &&
      new Set(winners.map((op) => op.vehicle)).size === 1;
    if (sameWinner) {
      for (const op of list) {
        if (op.issuedAt < top) taskReassignStale.add(op.id);
      }
    }
    // 同刻多车改派在车辆/司机环节继续处理
  }

  // ---- 4. 同一车辆同一班次只留一条有效占用 ----
  type Candidate = {
    op: DispatchOp;
    status: MergeStatus;
    reason: string;
    committed: boolean;
    /** 同一 opId 多份副本时用于区分行键 */
    duplicateTag?: string;
  };
  const items: Candidate[] = [];
  const pushItem = (candidate: Candidate) => items.push(candidate);
  const hasOp = (op: DispatchOp) => items.some((item) => item.op === op);
  /** 同一对象引用唯一对应一条结果，避免同 id 多份副本互相覆盖 */
  const putOp = (
    op: DispatchOp,
    status: MergeStatus,
    reason: string,
    duplicateTag?: string
  ) => {
    const index = items.findIndex((item) => item.op === op);
    const candidate: Candidate = { op, status, reason, committed: isCommitted(op), duplicateTag };
    if (index >= 0) items[index] = candidate;
    else items.push(candidate);
  };

  for (const op of allOps) {
    const arb = taskArbitration.get(op.taskId)!;
    if (op.type === "editTask") {
      if (arb.conflictIds.has(op.id)) {
        pushItem({ op, status: "review", reason: "多设备同刻编辑，版本内容不一致，需人工核对", committed: isCommitted(op) });
      } else if (arb.staleEditIds.has(op.id)) {
        pushItem({ op, status: "superseded", reason: arb.staleReason.get(op.id)!, committed: isCommitted(op) });
      } else {
        pushItem({ op, status: "accepted", reason: "任务有效版本（按发起时刻仲裁）", committed: isCommitted(op) });
      }
    }
  }

  for (const id of idConflictIds) {
    putOp(
      idConflictOps.get(id)![0],
      "review",
      "同一记录 id 在不同批次中内容不一致，需核对",
      "副本1"
    );
  }
  for (const op of retryMismatchOps) {
    putOp(op, "review", "本地重试记录与已确认内容不一致，需核对", "本地副本");
  }

  const vehicleGroups = new Map<string, DispatchOp[]>();
  const liveAssigns = assigns.filter(
    (op) =>
      !taskArbitration.get(op.taskId)!.conflictIds.has(op.id) &&
      !taskReassignStale.has(op.id) &&
      !idConflictIds.has(op.id) &&
      !retryMismatchRefs.has(op)
  );
  for (const op of liveAssigns) {
    const key = `${op.vehicle}::${op.shift}`;
    const list = vehicleGroups.get(key) ?? [];
    list.push(op);
    vehicleGroups.set(key, list);
  }

  /** 车辆占用胜者进入下一环节，其余置为对应状态 */
  const vehicleWinners = new Set<string>();
  const reviewByVehicleTie = new Set<string>();

  for (const list of vehicleGroups.values()) {
    if (list.length === 1) {
      vehicleWinners.add(list[0].id);
      continue;
    }
    const top = Math.max(...list.map((op) => op.issuedAt));
    const leaders = list.filter((op) => op.issuedAt === top);
    const sameSignature = new Set(leaders.map(assignSignature)).size === 1;

    if (sameSignature) {
      // 同刻同内容：确定的重复派车，按上传时刻兜底保留一条
      const winner = [...leaders].sort((a, b) => a.uploadedAt - b.uploadedAt)[0];
      vehicleWinners.add(winner.id);
      for (const op of list) {
        if (op.id === winner.id) continue;
        putOp(
          op,
          "superseded",
          op.issuedAt === top
            ? "同刻同内容重复派车，已去重"
            : "同一车辆同一班次已取发起时刻最新的占用"
        );
      }
    } else {
      // 同刻但车辆/司机/任务不同：先后无法判定
      for (const op of leaders) {
        reviewByVehicleTie.add(op.id);
        putOp(op, "review", "同一车辆同一班次存在同刻派车，先后无法判定");
      }
      for (const op of list) {
        if (op.issuedAt < top) {
          putOp(op, "superseded", "同一车辆同一班次已取发起时刻最新的占用");
        }
      }
    }
  }

  for (const op of assigns) {
    if (taskReassignStale.has(op.id) && !retryMismatchRefs.has(op) && !hasOp(op)) {
      putOp(op, "superseded", "该任务已改派，原派车被覆盖");
    }
  }

  // ---- 5. 司机占用：同一司机同一班次要对得上，多车占用留待核对 ----
  const driverGroups = new Map<string, DispatchOp[]>();
  for (const op of liveAssigns) {
    if (!vehicleWinners.has(op.id)) continue;
    const key = `${op.driver} ${op.shift}`;
    const group = driverGroups.get(key) ?? [];
    group.push(op);
    driverGroups.set(key, group);
  }

  const driverReview = new Set<string>();
  for (const group of driverGroups.values()) {
    // 不同车辆 / 不同任务才是占用冲突；同任务改派已在第 3 步处理
    const vehicles = new Set(group.map((op) => op.vehicle));
    const tasks = new Set(group.map((op) => op.taskId));
    if (vehicles.size === 1 || tasks.size === 1) continue;

    const forced = group.filter((op) => op.forceAccepted);
    const unforced = group.filter((op) => !op.forceAccepted);
    // 多条强制确认却指向不同车辆，互相矛盾，全部留待核对
    const forcedVehicles = new Set(forced.map((op) => op.vehicle));
    let toReview: DispatchOp[];
    if (forcedVehicles.size > 1) {
      toReview = group;
    } else if (forced.length > 0) {
      // 已人工强制确认的占用视为成立；其余仍无法自动判定
      toReview = unforced;
    } else {
      toReview = group;
    }
    for (const op of toReview) {
      driverReview.add(op.id);
      putOp(op, "review", "同一司机同一班次被多车占用，需核对实际去向");
    }
  }

  // ---- 6. 区域容量排队（已确认占用先占位，其余按发起时刻先后入队） ----
  const pendingAssigns = liveAssigns.filter(
    (op) =>
      vehicleWinners.has(op.id) &&
      !driverReview.has(op.id) &&
      !reviewByVehicleTie.has(op.id) &&
      !hasOp(op)
  );

  const zoneShiftGroups = new Map<string, DispatchOp[]>();
  for (const op of pendingAssigns) {
    const key = `${op.zone} ${op.shift}`;
    const list = zoneShiftGroups.get(key) ?? [];
    list.push(op);
    zoneShiftGroups.set(key, list);
  }

  for (const [key, list] of zoneShiftGroups) {
    const [zone, shift] = key.split(" ");
    const config = zoneMap.get(zone);
    const ordered = [...list].sort((a, b) =>
      a.issuedAt !== b.issuedAt ? a.issuedAt - b.issuedAt : a.uploadedAt - b.uploadedAt
    );

    if (!config) {
      for (const op of ordered) {
        putOp(op, "review", `区域「${zone}」未配置容量，待核对`);
      }
      continue;
    }

    // 已确认的有效占用保留席位
    let active = ordered.filter((op) => isCommitted(op)).length;
    let queued = 0;

    for (const op of ordered) {
      if (isCommitted(op)) {
        putOp(op, "accepted", "上一次已确认的有效占用");
        continue;
      }
      if (active < config.capacity) {
        active += 1;
        putOp(op, "accepted", "区域容量内，派车有效");
      } else if (queued < config.queueLimit) {
        queued += 1;
        putOp(op, "queued", `区域容量 ${config.capacity} 已满，排队等待（第 ${queued} 位）`);
      } else {
        putOp(
          op,
          "review",
          `超出区域容量与排队上限（容量 ${config.capacity} / 排队 ${config.queueLimit}），待核对`
        );
      }
    }
  }

  // 活下来的派车若因区域缺失等原因未入表，兜底进核对
  for (const op of liveAssigns) {
    if (vehicleWinners.has(op.id) && !hasOp(op)) {
      putOp(op, "review", "占用状态无法自动判定，待核对");
    }
  }

  // ---- 7. 组装结果 ----
  const mergeItems: MergeItem[] = items.map((candidate, index) => {
    const arb = taskArbitration.get(candidate.op.taskId)!;
    return {
      rowKey: candidate.duplicateTag ? `${candidate.op.id}#${candidate.duplicateTag}-${index}` : candidate.op.id,
      opId: candidate.op.id,
      op: candidate.op,
      status: candidate.status,
      reason: candidate.reason,
      committed: candidate.committed,
      effectiveTaskTitle: arb.title,
      effectiveTaskVersion: arb.version,
      resolved: candidate.op.forceAccepted === true
    };
  });
  for (const both of idConflictOps.values()) {
    for (const [index, op] of both.slice(1).entries()) {
      const arb = taskArbitration.get(op.taskId);
      mergeItems.push({
        rowKey: `${op.id}#副本${index + 2}`,
        opId: op.id,
        op,
        status: "review",
        reason: "同一记录 id 在不同批次中内容不一致（重复副本），需核对",
        committed: false,
        effectiveTaskTitle: arb?.title ?? op.taskTitle,
        effectiveTaskVersion: arb?.version ?? op.taskVersion,
        resolved: false
      });
    }
  }
  mergeItems.sort((a, b) => {
    if (STATUS_RANK[a.status] !== STATUS_RANK[b.status]) {
      return STATUS_RANK[a.status] - STATUS_RANK[b.status];
    }
    return b.op.issuedAt - a.op.issuedAt;
  });

  // 区域统计（含未配置区域）
  const zoneStats = new Map<string, ZoneMergeStat>();
  for (const config of zones) {
    zoneStats.set(config.zone, { ...config, active: 0, queued: 0, review: 0 });
  }
  for (const item of mergeItems) {
    if (item.op.type !== "assign") continue;
    let stat = zoneStats.get(item.op.zone);
    if (!stat) {
      stat = { zone: item.op.zone, capacity: 0, queueLimit: 0, active: 0, queued: 0, review: 0 };
      zoneStats.set(item.op.zone, stat);
    }
    if (item.status === "accepted") stat.active += 1;
    else if (item.status === "queued") stat.queued += 1;
    else if (item.status === "review") stat.review += 1;
  }

  const vehicleOccupancy: VehicleOccupancy[] = mergeItems
    .filter((item) => item.status === "accepted" && item.op.type === "assign")
    .map((item) => ({
      vehicle: item.op.vehicle,
      shift: item.op.shift,
      driver: item.op.driver,
      zone: item.op.zone,
      opId: item.opId,
      issuedAt: item.op.issuedAt
    }));

  const summary: MergeResult["summary"] = {
    generatedAt: now,
    totalOps: mergeItems.length,
    accepted: mergeItems.filter((item) => item.status === "accepted").length,
    queued: mergeItems.filter((item) => item.status === "queued").length,
    review: mergeItems.filter((item) => item.status === "review").length,
    superseded: mergeItems.filter((item) => item.status === "superseded").length,
    batchCount: batches.length
  };

  return {
    items: mergeItems,
    zones: [...zoneStats.values()],
    vehicleOccupancy,
    reviewItems: mergeItems.filter((item) => item.status === "review"),
    summary
  };
}
