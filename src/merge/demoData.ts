import type { DispatchOp, OutboxBatch } from "../types";

/**
 * 离线重连演示数据：
 * - 设备 A/B 各自离线派车，上传顺序被打乱
 * - 同车同班次重复派车（去重 + 旧版本失效）
 * - 多设备同任务编辑（按发起时刻仲裁 + 同刻冲突待核对）
 * - 司机双占、区域溢出排队
 */
export function buildDemoBatches(): OutboxBatch[] {
  const day = "2026-10-01";
  const shift = `${day}/早班`;
  const base = new Date(`${day}T08:00:00`).getTime();
  const min = 60_000;

  const opsA: DispatchOp[] = [
    {
      id: "demo-a1",
      batchId: "demo-batch-a",
      deviceId: "调度台-01",
      issuedAt: base + 5 * min,
      uploadedAt: base + 95 * min, // 故意晚上传
      shift,
      vehicle: "沪A-82L6",
      driver: "董飞",
      zone: "城北",
      taskId: "T-1001",
      taskTitle: "商超补货",
      taskVersion: 1,
      type: "assign"
    },
    {
      id: "demo-a2",
      batchId: "demo-batch-a",
      deviceId: "调度台-01",
      issuedAt: base + 12 * min,
      driver: "蒋琳",
      zone: "城北",
      uploadedAt: base + 96 * min,
      shift,
      vehicle: "沪A-55T2",
      taskId: "T-1002",
      taskTitle: "生鲜冷链",
      taskVersion: 1,
      type: "assign"
    },
    {
      id: "demo-a3",
      batchId: "demo-batch-a",
      deviceId: "调度台-01",
      issuedAt: base + 20 * min,
      uploadedAt: base + 97 * min,
      shift,
      vehicle: "沪A-82L6",
      driver: "董飞",
      zone: "城北",
      taskId: "T-1001",
      taskTitle: "商超补货（加单）",
      taskVersion: 2,
      type: "assign"
    },
    {
      id: "demo-edit-a",
      batchId: "demo-batch-a",
      deviceId: "调度台-01",
      issuedAt: base + 30 * min,
      uploadedAt: base + 98 * min,
      shift,
      vehicle: "",
      driver: "",
      zone: "城北",
      taskId: "T-1002",
      taskTitle: "生鲜冷链-改10点送达",
      taskVersion: 2,
      type: "editTask"
    },
    {
      // 城北容量 2：a3、b3 占满后，a4 排队
      id: "demo-a4",
      batchId: "demo-batch-a",
      deviceId: "调度台-01",
      issuedAt: base + 35 * min,
      uploadedAt: base + 99 * min,
      shift,
      vehicle: "沪D-12X4",
      driver: "沈越",
      zone: "城北",
      taskId: "T-1004",
      taskTitle: "建材配送",
      taskVersion: 1,
      type: "assign"
    }
  ];

  const opsB: DispatchOp[] = [
    {
      id: "demo-b1",
      batchId: "demo-batch-b",
      deviceId: "手持终端-07",
      issuedAt: base + 7 * min,
      uploadedAt: base + 40 * min, // 发起更早却先上传，不能因此判赢
      shift,
      vehicle: "沪B-73K9",
      driver: "周航",
      zone: "城东",
      taskId: "T-2001",
      taskTitle: "医药配送",
      taskVersion: 1,
      type: "assign"
    },
    {
      id: "demo-b2",
      batchId: "demo-batch-b",
      deviceId: "手持终端-07",
      issuedAt: base + 18 * min,
      uploadedAt: base + 41 * min,
      shift,
      vehicle: "沪C-77Q1",
      driver: "蒋琳", // 与 demo-a2 同一司机、不同车辆 → 司机双占待核对
      zone: "城东",
      taskId: "T-2002",
      taskTitle: "加急样品",
      taskVersion: 1,
      type: "assign"
    },
    {
      id: "demo-b3",
      batchId: "demo-batch-b",
      deviceId: "手持终端-07",
      issuedAt: base + 25 * min,
      uploadedAt: base + 42 * min,
      shift,
      vehicle: "沪B-91P8",
      driver: "韩硕",
      zone: "城北",
      taskId: "T-1003",
      taskTitle: "家电配送",
      taskVersion: 1,
      type: "assign"
    },
    {
      // 多设备同刻同版本改同一任务、内容不同 → 待核对
      id: "demo-edit-b",
      batchId: "demo-batch-b",
      deviceId: "手持终端-07",
      issuedAt: base + 30 * min,
      uploadedAt: base + 43 * min,
      shift,
      vehicle: "",
      driver: "",
      zone: "城北",
      taskId: "T-1002",
      taskTitle: "生鲜冷链-改11点送达",
      taskVersion: 2,
      type: "editTask"
    }
  ];

  return [
    { id: "demo-batch-a", deviceId: "调度台-01", createdAt: base + 95 * min, ops: opsA, retryCount: 0 },
    {
      id: "demo-batch-b",
      deviceId: "手持终端-07",
      createdAt: base + 40 * min,
      ops: opsB,
      retryCount: 1,
      lastError: "网络不可达，写入被拒绝（模拟）"
    }
  ];
}
