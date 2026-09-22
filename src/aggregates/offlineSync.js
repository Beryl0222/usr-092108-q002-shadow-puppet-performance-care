import { randomUUID } from "node:crypto";

import { EventStore } from "../store/eventStore.js";
import { assertValidEnvelope } from "../validator.js";
import { loanAggregate } from "./loanAggregate.js";

/**
 * 离线账本：巡演设备在无网络时先把事实记在本地，
 * 版本号基于出库/出发时拿到的基线版本递增；重连后整批交给 syncBatch 对账。
 */
export class OfflineLedger {
  constructor(deviceId, baseVersions = new Map()) {
    this.deviceId = deviceId;
    this.baseVersions = new Map(baseVersions); // streamKey -> 已知服务器版本
    this.pending = [];
    this._localCount = new Map();
  }

  stage(entry) {
    const streamKey = EventStore.streamKey(entry.aggregateType, entry.aggregateId);
    const base = this.baseVersions.get(streamKey) ?? 0;
    const n = (this._localCount.get(streamKey) ?? 0) + 1;
    this._localCount.set(streamKey, n);
    const event = {
      event_id: `${this.deviceId}-${randomUUID()}`,
      event_type: entry.eventType,
      aggregate_type: entry.aggregateType,
      aggregate_id: entry.aggregateId,
      occurred_at: entry.occurredAt ?? new Date().toISOString(),
      version: base + n,
      summary: entry.summary,
      payload: entry.payload ?? {},
      sync_batch_id: entry.batchId ?? `batch-${this.deviceId}`,
      ...(entry.causedBy ? { caused_by: entry.causedBy } : {}),
      expected_version: base,
    };
    assertValidEnvelope(event);
    this.pending.push(event);
    return event;
  }

  /** 同步成功后用服务器权威版本推进基线。 */
  advanceBase(streamKey, version) {
    this.baseVersions.set(streamKey, Math.max(this.baseVersions.get(streamKey) ?? 0, version));
    this._localCount.delete(streamKey);
  }
}

/**
 * 批次同步：
 *  1. 按 event_id 幂等去重（同一批重复投递不产生双份事实）；
 *  2. 逐流比较基线：
 *     - 对齐 → 直接快进追加；
 *     - 分叉 → 语义判定：
 *        · 借用流的交接/出库若与服务器现状矛盾（同一物件出现两个持有人），
 *          整支拒绝，并向权威流追加 CUSTODY_CONFLICT_DETECTED；
 *        · 其余追加性事实（环境读数、训练记录等）重编号后合并保留。
 *
 * @returns {{applied: object[], skipped: object[], merged: object[], conflicts: object[]}}
 */
export function syncBatch(store, events, options = {}) {
  const known = new Set(store.loadAll().map((e) => e.event_id));
  const groups = new Map();
  const applied = [];
  const skipped = [];

  for (const event of events) {
    assertValidEnvelope(event);
    if (known.has(event.event_id)) {
      skipped.push({ event_id: event.event_id, reason: "duplicate_event_id" });
      continue;
    }
    const key = EventStore.streamKey(event.aggregate_type, event.aggregate_id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }

  const merged = [];
  const conflicts = [];

  // 借用流跨流语义冲突（两台设备各自开单）必须统一裁决：
  // 按首条事实时间排序，先到者入库，后到者被拒绝。
  const ordered = [...groups.entries()].sort((a, b) => {
    const firstOf = (evs) => evs.slice().sort((x, y) => x.occurred_at.localeCompare(y.occurred_at))[0];
    const fa = firstOf(a[1]);
    const fb = firstOf(b[1]);
    return fa.occurred_at.localeCompare(fb.occurred_at) || fa.event_id.localeCompare(fb.event_id);
  });

  for (const [streamKey, localEventsRaw] of ordered) {
    const localEvents = localEventsRaw
      .slice()
      .sort((a, b) => a.version - b.version || a.occurred_at.localeCompare(b.occurred_at));
    const serverEvents = store.load(streamKey);
    const baseVersion = localEvents[0].version - 1;

    // 借用流无论是否版本对齐，都要过语义裁决（新流对齐也可能是重复出库）
    if (streamKey.startsWith("loan_record:")) {
      const verdict = evaluateLoanBranch(serverEvents, localEvents, options.registry, streamKey);
      if (!verdict.ok) {
        conflicts.push(rejectBranch(store, streamKey, localEvents, verdict.reason));
        continue;
      }
    }

    if (serverEvents.length === baseVersion) {
      // 基线对齐：本地版本号可直接落库
      for (const event of localEvents) {
        store.append(streamKey, [event], serverEvents.length);
        applied.push(event);
      }
      continue;
    }

    if (serverEvents.length < baseVersion) {
      // 本地基于一个服务器都不认识的未来版本，数据来源异常
      conflicts.push(
        rejectBranch(store, streamKey, localEvents, `本地基线 v${baseVersion} 超出服务器 v${serverEvents.length}，来源不明`),
      );
      continue;
    }

    // serverEvents.length > baseVersion → 真分叉；追加性事实重编号合并
    let renumberFrom = serverEvents.length;
    for (const event of localEvents) {
      renumberFrom += 1;
      const renumbered = { ...event, version: renumberFrom };
      store.append(streamKey, [renumbered], renumberFrom - 1);
      merged.push(renumbered);
    }
  }

  return { applied, skipped, merged, conflicts };
}

/**
 * 借用流分叉语义：把服务器流折叠到当前状态，逐条验证本地分支是否仍然成立。
 * 即使是全新借用流（服务器无事件），也要跨流检查同一物件是否已被其他单出库。
 */
function evaluateLoanBranch(serverEvents, localEvents, registry, streamKey) {
  let server = loanAggregate.initial();
  for (const e of serverEvents) server = loanAggregate.fold(server, e);

  for (const event of localEvents) {
    const p = event.payload ?? {};
    switch (event.event_type) {
      case "LOAN_CHECKED_OUT": {
        // 同一流内已存在未结清借用
        if (server.status && server.status !== "returned" && server.puppet_id === p.puppet_id) {
          return {
            ok: false,
            reason: `物件 ${p.puppet_id} 在服务器上已有未结清借用（持有人 ${server.current_custodian_id}），本地出库将造成两个当前位置`,
          };
        }
        // 跨流检查：另一张借用单已出库同一物件（两台设备各自开单）
        if (registry) {
          const other = registry.loanByPuppet(p.puppet_id);
          const thisLoanId = streamKey.slice("loan_record:".length);
          if (other && other.loan.loan_id !== thisLoanId) {
            return {
              ok: false,
              reason: `物件 ${p.puppet_id} 已由借用单 ${other.loan.loan_id} 出库（持有人 ${other.current_custodian_id}），本地单 ${thisLoanId} 被拒绝`,
            };
          }
        }
        server = loanAggregate.fold(server, event);
        break;
      }
      case "CUSTODY_TRANSFERRED":
        if (server.current_custodian_id && p.from_custodian_id !== server.current_custodian_id) {
          return {
            ok: false,
            reason: `交接链冲突：服务器当前持有人为 ${server.current_custodian_id}，本地记录却从 ${p.from_custodian_id} 交给 ${p.to_custodian_id}`,
          };
        }
        server = loanAggregate.fold(server, event);
        break;
      case "LOAN_RETURNED":
        if (server.current_custodian_id && p.returned_by !== server.current_custodian_id) {
          return {
            ok: false,
            reason: `归还冲突：服务器当前持有人为 ${server.current_custodian_id}，本地却由 ${p.returned_by} 归还`,
          };
        }
        server = loanAggregate.fold(server, event);
        break;
      default:
        server = loanAggregate.fold(server, event);
    }
  }
  return { ok: true };
}

/** 拒绝整条本地分支：不落任何本地事件；借用流向权威流追加冲突留痕。 */
function rejectBranch(store, streamKey, rejectedEvents, reason) {
  const [aggregateType, aggregateId] = splitStreamKey(streamKey);
  const puppetId = rejectedEvents[0]?.payload?.puppet_id ?? "";
  let conflictEventId = null;

  if (aggregateType === "loan_record") {
    const version = store.streamVersion(streamKey) + 1;
    const conflictEvent = {
      event_id: `conflict-${randomUUID().slice(0, 8)}`,
      event_type: "CUSTODY_CONFLICT_DETECTED",
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: new Date().toISOString(),
      version,
      summary: `离线同步拒绝 ${rejectedEvents.length} 条事件：${reason}`,
      payload: {
        loan_id: aggregateId,
        puppet_id: puppetId,
        conflict: reason,
        rejected_event_ids: rejectedEvents.map((e) => e.event_id),
      },
    };
    store.append(streamKey, [conflictEvent], version - 1);
    conflictEventId = conflictEvent.event_id;
  }

  return {
    stream_key: streamKey,
    reason,
    rejected_event_ids: rejectedEvents.map((e) => e.event_id),
    ...(conflictEventId ? { conflict_event_id: conflictEventId } : {}),
  };
}

function splitStreamKey(streamKey) {
  const idx = streamKey.indexOf(":");
  return [streamKey.slice(0, idx), streamKey.slice(idx + 1)];
}
