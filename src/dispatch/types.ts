// 离线派车合并领域模型

export type Shift = "早班" | "晚班";
export const SHIFTS: readonly Shift[] = ["早班", "晚班"];

export type DispatchAction = "assign" | "cancel";

/** 任务基础版本（服务端台账） */
export interface BaseTask {
  id: string;
  title: string;
  /** 任务所属区域；"—" 表示任务不绑定区域 */
  zone: string;
  version: number;
}

/**
 * 不同设备对同一任务的修改记录。
 * 合并时按发起时刻（issuedAt）取最新，不看上传/到达顺序。
 */
export interface TaskEdit {
  id: string;
  taskId: string;
  /** 该修改基于哪个任务版本 */
  baseVersion: number;
  zone?: string;
  title?: string;
  deviceId: string;
  /** 发起时刻：冲突判定的唯一权威时间 */
  issuedAt: string;
}

/**
 * 一笔派车记录：发起时刻、车辆、司机、任务版本四要素齐全。
 * uploadedAt 只用于展示批次上传情况，绝不参与合并判定。
 */
export interface DispatchOp {
  id: string;
  action: DispatchAction;
  vehicleId: string;
  driver: string;
  zone: string;
  shift: Shift;
  taskId: string;
  /** 发起时看到的任务版本；低于有效版本说明引用了旧任务 */
  taskVersion: number;
  deviceId: string;
  issuedAt: string;
}

export type BatchStatus = "pending" | "failed" | "synced";

/** 离线期间攒在本地的派车批次，写入失败也原样保留 */
export interface DispatchBatch {
  id: string;
  deviceId: string;
  ops: DispatchOp[];
  taskEdits: TaskEdit[];
  status: BatchStatus;
  createdAt: string;
  uploadedAt?: string;
  lastError?: string;
}

export type ReviewReason =
  | "driver-double" // 同一司机同一时段被多车占用
  | "zone-overflow" // 超出区域容量，排队待核对
  | "zone-unknown" // 区域不在容量字典，无法判定
  | "stale-task" // 引用任务版本已过期且区域与有效版本不一致
  | "task-missing" // 引用的任务不存在
  | "task-conflict"; // 多设备同刻修改同一任务且内容不同，无法判定

export interface Resolution {
  /** confirm / reject，或 task-conflict 时被采用的 editId */
  action: string;
  note?: string;
  at: string;
}

export interface ReviewItem {
  /** 由原因 + 相关记录 id 派生，重算后保持稳定，可持久化人工结论 */
  id: string;
  reason: ReviewReason;
  title: string;
  message: string;
  /** 相关派车记录（候选占用通常取第一条）；任务级冲突可能只有 editIds */
  opIds?: string[];
  /** task-conflict 时各设备的修改 */
  editIds?: string[];
  taskId?: string;
  zone?: string;
  shift?: string;
  vehicleId?: string;
  driver?: string;
  /** 组内最晚发起时刻，用于核对区排序 */
  issuedAt: string;
  resolution?: Resolution;
}

export interface EffectiveOccupancy {
  opId: string;
  vehicleId: string;
  driver: string;
  zone: string;
  shift: Shift;
  taskId: string;
  taskVersion: number;
  deviceId: string;
  issuedAt: string;
  /** 人工在核对区确认放行的占用 */
  manual: boolean;
}

export interface QueueEntry extends EffectiveOccupancy {
  reviewId: string;
  queueRank: number;
  capacity: number;
}

export interface EffectiveTaskVersion {
  taskId: string;
  title: string;
  zone: string;
  version: number;
  /** 生效修改的发起时刻（取基础版本时为 undefined） */
  issuedAt?: string;
  deviceId?: string;
  /** 同刻冲突未决，暂回退基础版本，等待核对 */
  disputed: boolean;
}

export interface MergeStats {
  totalOps: number;
  assigns: number;
  cancels: number;
  effective: number;
  manualEffective: number;
  queued: number;
  pendingReviews: number;
  resolvedReviews: number;
  cancelledGroups: number;
  superseded: number;
  disputedTasks: number;
}

export interface ZoneUsage {
  zone: string;
  shift: Shift;
  capacity: number;
  used: number;
  queued: number;
}

export interface SupersededOp {
  op: DispatchOp;
  byOpId: string;
  /** 胜出记录是取消时，该记录实际为被取消 */
  winnerCancels: boolean;
}

export interface MergeResult {
  generatedAt: string;
  effective: EffectiveOccupancy[];
  queued: QueueEntry[];
  reviews: ReviewItem[];
  tasks: EffectiveTaskVersion[];
  zoneUsage: ZoneUsage[];
  cancelled: DispatchOp[];
  superseded: SupersededOp[];
  stats: MergeStats;
}

export interface MergeInput {
  ops: DispatchOp[];
  taskEdits: TaskEdit[];
  baseTasks: BaseTask[];
  /** key: `${zone}|${shift}` */
  capacities: Record<string, number>;
}
