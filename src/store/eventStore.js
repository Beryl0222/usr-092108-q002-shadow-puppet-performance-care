import { randomUUID } from "node:crypto";

import { ConcurrencyError } from "../errors.js";
import { assertValidEnvelope } from "../validator.js";

/**
 * 只追加的事件存储（内存实现；接口可替换为持久化版本）。
 *
 * 流键为 `${aggregate_type}:${aggregate_id}`，流内 version 从 1 连续递增。
 * append 时携带 expectedVersion 做乐观并发控制——离线设备各自记账后
 * 同步批次，若同一流已被其他设备追加，即在此暴露分叉。
 */
export class EventStore {
  #streams = new Map();
  #all = [];

  /**
   * @param {string} streamKey
   * @param {Array<object>} events 已带 version 的完整事件
   * @param {number} [expectedVersion] 追加前期望的流版本
   */
  append(streamKey, events, expectedVersion) {
    const current = this.#streams.get(streamKey) ?? [];
    if (expectedVersion !== undefined && current.length !== expectedVersion) {
      throw new ConcurrencyError(
        `流 ${streamKey} 版本冲突：本地基于 v${expectedVersion}，服务器已到 v${current.length}`,
        {
          stream_key: streamKey,
          local_base_version: expectedVersion,
          server_version: current.length,
        },
      );
    }
    for (const event of events) {
      assertValidEnvelope(event);
      if (event.version !== current.length + 1) {
        throw new ConcurrencyError(
          `流 ${streamKey} 出现版本缺口或重复：期望 v${current.length + 1}，收到 v${event.version}`,
          { stream_key: streamKey, received_version: event.version, expected: current.length + 1 },
        );
      }
      current.push(event);
      this.#all.push(event);
    }
    this.#streams.set(streamKey, current);
    return events;
  }

  load(streamKey) {
    return (this.#streams.get(streamKey) ?? []).slice();
  }

  loadAll() {
    return this.#all.slice();
  }

  /** 按聚合类型取事件（供读模型订阅）。 */
  byAggregateType(aggregateType) {
    return this.#all.filter((e) => e.aggregate_type === aggregateType);
  }

  streamVersion(streamKey) {
    return (this.#streams.get(streamKey) ?? []).length;
  }

  keys() {
    return [...this.#streams.keys()];
  }

  static streamKey(aggregateType, aggregateId) {
    return `${aggregateType}:${aggregateId}`;
  }
}

let sequence = 0;
/** 生成事件标识：时间戳 + 进程内序号，离线设备可用 deviceId 前缀保证全局不撞。 */
export function newEventId(prefix = "evt") {
  sequence += 1;
  return `${prefix}-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}-${sequence}-${randomUUID().slice(0, 8)}`;
}
