/**
 * 离线派车合并领域模型
 *
 * 关键约定：
 * - issuedAt 派车/编辑的「发起时刻」，是版本仲裁的主依据
 * - uploadedAt 「上传时刻」，仅作同刻兜底，绝不决定版本先后
 * - 同一车辆同一班次只保留一条有效占用
 * - 区域按容量排队，超出容量与排队上限的记录进入核对区
 */

export type OpType = "assign" | "editTask";

/** 合并后每条记录的归宿 */
export type MergeStatus =
  | "accepted" // 有效占用 / 任务有效版本
  | "queued" // 区域容量已满，排队等待
  | "review" // 冲突无法自动判定，待人工核对
  | "superseded"; // 已被发起时刻更新的记录取代

export interface ZoneConfig {
  zone: string;
  /** 区域内同时有效占用上限 */
  capacity: number;
  /** 容量满后允许排队的条数；为 0 时溢出直接待核对 */
  queueLimit: number;
}

/**
 * 一笔派车 / 任务编辑记录。
 * 离线期间由设备本地生成，重连后随「本地批次」上传。
 */
export interface DispatchOp {
  /** 客户端生成的幂等键，同一笔记录在多个批次重试只算一次 */
  id: string;
  /** 所属本地批次 */
  batchId: string;
  /** 发起设备（多设备编辑同一任务时用于判定冲突） */
  deviceId: string;
  /** 发起时刻（毫秒时间戳），仲裁主依据 */
  issuedAt: number;
  /** 上传时刻（毫秒时间戳），仅同刻兜底用 */
  uploadedAt: number;
  /** 班次标识，如 2026-10-01/早班 */
  shift: string;
  vehicle: string;
  driver: string;
  zone: string;
  /** 任务标识，同一任务的多设备编辑按它归并 */
  taskId: string;
  taskTitle: string;
  /** 任务版本号，越大越新；发起时刻相同时辅助判定因果 */
  taskVersion: number;
  type: OpType;
  /** 核对区人工确认后放行，绕过司机占用冲突（容量规则仍然生效） */
  forceAccepted?: boolean;
  /** 人工处理备注（作废原因 / 强制确认说明） */
  resolveNote?: string;
}

/** 离线期间保留在本地的写入批次，失败后原样保留并累加重试次数 */
export interface OutboxBatch {
  id: string;
  deviceId: string;
  createdAt: number;
  ops: DispatchOp[];
  retryCount: number;
  lastError?: string;
}

export interface MergeItem {
  /** 结果行唯一键；同一 opId 出现多份冲突副本时彼此不同 */
  rowKey: string;
  opId: string;
  op: DispatchOp;
  status: MergeStatus;
  reason: string;
  /** 是否来自上一次已确认同步的服务端状态 */
  committed: boolean;
  /** 合并后该任务的有效标题（被后续编辑更新时与 op 自带标题不同） */
  effectiveTaskTitle?: string;
  effectiveTaskVersion?: number;
  /** 已在核对区人工处理 */
  resolved?: boolean;
}

export interface ZoneMergeStat extends ZoneConfig {
  active: number;
  queued: number;
  review: number;
}

export interface VehicleOccupancy {
  vehicle: string;
  shift: string;
  driver: string;
  zone: string;
  opId: string;
  issuedAt: number;
}

export interface MergeSummary {
  generatedAt: number;
  totalOps: number;
  accepted: number;
  queued: number;
  review: number;
  superseded: number;
  batchCount: number;
}

export interface MergeResult {
  items: MergeItem[];
  zones: ZoneMergeStat[];
  /** 每个「车辆|班次」当前的有效占用 */
  vehicleOccupancy: VehicleOccupancy[];
  reviewItems: MergeItem[];
  summary: MergeSummary;
}
