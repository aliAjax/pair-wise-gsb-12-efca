import type { DispatchBatch } from "./types";
import { ZONES } from "./seed";

const KNOWN_ZONES = new Set(ZONES.filter((z) => z !== "开发区"));

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface UploadOptions {
  online: boolean;
  /** 模拟服务端自身故障（非网络问题） */
  serverFault: boolean;
}

/**
 * 模拟服务端写入。本地优先：任何失败都不丢批次，由调用方保留原批次，
 * 调度员修正后可原样重试。规则刻意做成确定性，便于演示。
 */
export async function uploadBatch(
  batch: DispatchBatch,
  options: UploadOptions
): Promise<{ ok: true; uploadedAt: string } | { ok: false; error: string }> {
  await delay(450);
  if (!options.online) {
    return { ok: false, error: "网络离线：写入未到达服务端，批次已保留在本地" };
  }
  if (options.serverFault) {
    return { ok: false, error: "服务端写入失败(500)：服务暂不可用，批次已保留，请稍后重试" };
  }
  const badOp = batch.ops.find((op) => op.zone && !KNOWN_ZONES.has(op.zone));
  if (badOp) {
    return {
      ok: false,
      error: `服务端校验失败：区域「${badOp.zone}」未纳管（记录 ${badOp.id}），请修正区域后重试`
    };
  }
  return { ok: true, uploadedAt: new Date().toISOString() };
}
