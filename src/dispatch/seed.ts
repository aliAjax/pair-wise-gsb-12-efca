import type { BaseTask, DispatchBatch } from "./types";

/** 任务台账基础版本 */
export const BASE_TASKS: BaseTask[] = [
  { id: "T-101", title: "商超补货", zone: "城北", version: 1 },
  { id: "T-102", title: "医药配送", zone: "城东", version: 2 },
  { id: "T-103", title: "建材短驳", zone: "城南", version: 1 },
  { id: "T-104", title: "生鲜急送", zone: "城北", version: 1 },
  { id: "T-105", title: "园区急件", zone: "城东", version: 1 }
];

/** 区域容量字典，key 为 `${区域}|${班次}`；未配置即无法判定 */
export const CAPACITIES: Record<string, number> = {
  "城北|早班": 2,
  "城东|早班": 1,
  "城南|早班": 2,
  "城北|晚班": 2,
  "城东|晚班": 1,
  "城南|晚班": 2
};

export const ZONES = ["城北", "城东", "城南", "开发区"];
export const VEHICLES = [
  "沪A-82L6",
  "沪B-73K9",
  "沪C-55T2",
  "沪D-11M8",
  "沪E-90Q7",
  "沪F-33X4",
  "沪G-27P5",
  "沪H-62R8",
  "沪J-11M8",
  "沪K-90Q7",
  "沪L-33X4",
  "沪M-27P5"
];

/**
 * 预置批次，覆盖全部合并场景（均为 2026-10-01）：
 * - 同车同班多笔派车，发起时刻晚者胜（OP-101/102、OP-301/302）
 * - 晚发起的取消整组作废（OP-303/304）
 * - 任务被多设备修改，按发起时刻取版本（TE-3 07:55 晚于 TE-4 07:20，
 *   尽管 B-003 比 B-001 更早"上传"）
 * - 同刻不同内容修改 T-103 → 无法判定，留待核对（TE-2a/2b）
 * - 引用旧任务版本且区域已变（OP-201）
 * - 同司机同班被多车占用（OP-202/203）
 * - 区域超容排队（OP-204、OP-401）
 * - 区域未配置容量（OP-205、OP-402）
 * - 写入失败的本地批次 B-004，修正后才能重试
 * - 尚未上传的离线批次 B-005
 */
export const SEED_BATCHES: DispatchBatch[] = [
  {
    id: "B-001",
    deviceId: "调度台-01",
    status: "synced",
    createdAt: "2026-10-01T08:00:00+08:00",
    uploadedAt: "2026-10-01T09:20:00+08:00",
    taskEdits: [
      {
        id: "TE-1",
        taskId: "T-102",
        baseVersion: 2,
        zone: "城北",
        deviceId: "调度台-01",
        issuedAt: "2026-10-01T07:50:00+08:00"
      },
      {
        id: "TE-3",
        taskId: "T-104",
        baseVersion: 1,
        title: "生鲜急送(北线)",
        deviceId: "调度台-01",
        issuedAt: "2026-10-01T07:55:00+08:00"
      }
    ],
    ops: [
      {
        id: "OP-101",
        action: "assign",
        vehicleId: "沪A-82L6",
        driver: "董飞",
        zone: "城北",
        shift: "早班",
        taskId: "T-101",
        taskVersion: 1,
        deviceId: "调度台-01",
        issuedAt: "2026-10-01T08:00:00+08:00"
      },
      {
        id: "OP-102",
        action: "assign",
        vehicleId: "沪A-82L6",
        driver: "王健",
        zone: "城北",
        shift: "早班",
        taskId: "T-104",
        taskVersion: 1,
        deviceId: "调度台-01",
        issuedAt: "2026-10-01T08:25:00+08:00"
      }
    ]
  },
  {
    id: "B-002",
    deviceId: "手持-02",
    status: "synced",
    createdAt: "2026-10-01T08:05:00+08:00",
    uploadedAt: "2026-10-01T09:35:00+08:00",
    taskEdits: [
      {
        id: "TE-2a",
        taskId: "T-103",
        baseVersion: 1,
        zone: "城东",
        deviceId: "手持-02",
        issuedAt: "2026-10-01T07:40:00+08:00"
      }
    ],
    ops: [
      {
        id: "OP-201",
        action: "assign",
        vehicleId: "沪C-55T2",
        driver: "周航",
        zone: "城东",
        shift: "早班",
        taskId: "T-102",
        taskVersion: 2,
        deviceId: "手持-02",
        issuedAt: "2026-10-01T08:05:00+08:00"
      },
      {
        id: "OP-202",
        action: "assign",
        vehicleId: "沪D-11M8",
        driver: "周航",
        zone: "城北",
        shift: "早班",
        taskId: "T-102",
        taskVersion: 3,
        deviceId: "手持-02",
        issuedAt: "2026-10-01T08:15:00+08:00"
      },
      {
        id: "OP-203",
        action: "assign",
        vehicleId: "沪E-90Q7",
        driver: "周航",
        zone: "城北",
        shift: "早班",
        taskId: "T-101",
        taskVersion: 1,
        deviceId: "手持-02",
        issuedAt: "2026-10-01T08:30:00+08:00"
      },
      {
        id: "OP-204",
        action: "assign",
        vehicleId: "沪F-33X4",
        driver: "李娜",
        zone: "城北",
        shift: "早班",
        taskId: "T-101",
        taskVersion: 1,
        deviceId: "手持-02",
        issuedAt: "2026-10-01T08:35:00+08:00"
      },
      {
        id: "OP-205",
        action: "assign",
        vehicleId: "沪G-27P5",
        driver: "陈旭",
        zone: "开发区",
        shift: "早班",
        taskId: "T-105",
        taskVersion: 1,
        deviceId: "手持-02",
        issuedAt: "2026-10-01T08:42:00+08:00"
      }
    ]
  },
  {
    id: "B-003",
    deviceId: "车载-03",
    status: "synced",
    createdAt: "2026-10-01T07:20:00+08:00",
    uploadedAt: "2026-10-01T09:10:00+08:00",
    taskEdits: [
      {
        id: "TE-2b",
        taskId: "T-103",
        baseVersion: 1,
        zone: "城北",
        deviceId: "车载-03",
        issuedAt: "2026-10-01T07:40:00+08:00"
      },
      {
        id: "TE-4",
        taskId: "T-104",
        baseVersion: 1,
        zone: "城南",
        title: "生鲜急送(南线)",
        deviceId: "车载-03",
        issuedAt: "2026-10-01T07:20:00+08:00"
      }
    ],
    ops: [
      {
        id: "OP-301",
        action: "assign",
        vehicleId: "沪H-62R8",
        driver: "孙力",
        zone: "城南",
        shift: "早班",
        taskId: "T-103",
        taskVersion: 1,
        deviceId: "车载-03",
        issuedAt: "2026-10-01T08:02:00+08:00"
      },
      {
        id: "OP-302",
        action: "assign",
        vehicleId: "沪H-62R8",
        driver: "何琴",
        zone: "城南",
        shift: "早班",
        taskId: "T-103",
        taskVersion: 1,
        deviceId: "车载-03",
        issuedAt: "2026-10-01T08:50:00+08:00"
      },
      {
        id: "OP-303",
        action: "assign",
        vehicleId: "沪J-11M8",
        driver: "郭帆",
        zone: "城南",
        shift: "早班",
        taskId: "T-103",
        taskVersion: 1,
        deviceId: "车载-03",
        issuedAt: "2026-10-01T08:12:00+08:00"
      },
      {
        id: "OP-304",
        action: "cancel",
        vehicleId: "沪J-11M8",
        driver: "郭帆",
        zone: "城南",
        shift: "早班",
        taskId: "T-103",
        taskVersion: 1,
        deviceId: "车载-03",
        issuedAt: "2026-10-01T09:05:00+08:00"
      },
      {
        id: "OP-305",
        action: "assign",
        vehicleId: "沪K-90Q7",
        driver: "赵磊",
        zone: "城东",
        shift: "早班",
        taskId: "T-105",
        taskVersion: 1,
        deviceId: "车载-03",
        issuedAt: "2026-10-01T08:10:00+08:00"
      }
    ]
  },
  {
    id: "B-004",
    deviceId: "手持-04",
    status: "failed",
    createdAt: "2026-10-01T09:02:00+08:00",
    uploadedAt: "2026-10-01T09:40:00+08:00",
    lastError: "服务端写入失败(500)：批次已保留，请修正后重试",
    taskEdits: [],
    ops: [
      {
        id: "OP-401",
        action: "assign",
        vehicleId: "沪L-33X4",
        driver: "韩雪",
        zone: "城北",
        shift: "早班",
        taskId: "T-101",
        taskVersion: 1,
        deviceId: "手持-04",
        issuedAt: "2026-10-01T08:48:00+08:00"
      },
      {
        id: "OP-402",
        action: "assign",
        vehicleId: "沪M-27P5",
        driver: "林强",
        zone: "开发区",
        shift: "早班",
        taskId: "T-101",
        taskVersion: 1,
        deviceId: "手持-04",
        issuedAt: "2026-10-01T08:55:00+08:00"
      }
    ]
  },
  {
    id: "B-005",
    deviceId: "调度台-01",
    status: "pending",
    createdAt: "2026-10-01T09:30:00+08:00",
    taskEdits: [],
    ops: [
      {
        id: "OP-501",
        action: "assign",
        vehicleId: "沪B-73K9",
        driver: "苏南",
        zone: "城南",
        shift: "晚班",
        taskId: "T-103",
        taskVersion: 1,
        deviceId: "调度台-01",
        issuedAt: "2026-10-01T09:18:00+08:00"
      }
    ]
  }
];
