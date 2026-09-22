import { randomUUID } from "node:crypto";
import { EVENT_CATALOG, assertValidContract } from "./contracts.js";

let seqCounter = 0;

function newEventId(type) {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const stamp = `${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  seqCounter = (seqCounter + 1) % 1000;
  return `${stamp}-${type.toLowerCase()}-${p(seqCounter, 3)}-${randomUUID().slice(0, 8)}`;
}

/**
 * 追加式领域事件存储。
 * - 事件一经接收，event_id / occurred_at / version 不再原地改写；更正只能追加后继事件。
 * - version 按聚合（aggregate_type + aggregate_id）单调递增，形成乐观并发边界。
 * - 幂等：同一 event_id 或同一离线客户端序号 (client_id, client_seq) 重复提交返回既有事件。
 */
export class EventStore {
  #events = [];
  #byId = new Map();
  #versions = new Map();
  #offlineKeys = new Map();
  #projector;

  constructor(projector) {
    this.#projector = projector;
  }

  get events() {
    return [...this.#events];
  }

  /** 从全部事件重新折叠读模型（测试或重启时使用）。 */
  rebuild(events) {
    this.#events = [];
    this.#byId = new Map();
    this.#versions = new Map();
    this.#offlineKeys = new Map();
    for (const e of events) this.#ingest(e);
    return this.#projector.rebuild(this.#events);
  }

  /**
   * 追加并应用一条事件。
   * @param {string} type 事件类型（见 EVENT_CATALOG）
   * @param {string} aggregateId 聚合标识
   * @param {object} payload 事件负载
   * @param {{summary?: string, occurredAt?: string|Date, offline?: object}} [opts]
   */
  append(type, aggregateId, payload, opts = {}) {
    const spec = EVENT_CATALOG[type];
    if (!spec) throw new Error(`未知事件类型：${type}`);

    if (opts.offline) {
      const key = `${opts.offline.client_id}:${opts.offline.client_seq}`;
      const existing = this.#offlineKeys.get(key);
      if (existing) return existing;
    }

    const aggregateKey = `${spec.aggregate}:${aggregateId}`;
    const version = (this.#versions.get(aggregateKey) ?? 0) + 1;
    const occurredAt = opts.occurredAt
      ? (opts.occurredAt instanceof Date ? opts.occurredAt.toISOString() : opts.occurredAt)
      : new Date().toISOString();

    const event = {
      event_id: opts.eventId ?? newEventId(type),
      event_type: type,
      aggregate_type: spec.aggregate,
      aggregate_id: aggregateId,
      occurred_at: occurredAt,
      version,
      summary: opts.summary ?? type,
      payload,
    };
    if (opts.offline) event.offline = opts.offline;

    assertValidContract(event); // 写入前最后一道契约防线
    this.#ingest(event);
    if (opts.offline) this.#offlineKeys.set(`${opts.offline.client_id}:${opts.offline.client_seq}`, event);
    this.#projector.apply(event);
    return event;
  }

  #ingest(event) {
    if (this.#byId.has(event.event_id)) return;
    this.#events.push(event);
    this.#byId.set(event.event_id, event);
    const key = `${event.aggregate_type}:${event.aggregate_id}`;
    this.#versions.set(key, event.version);
    if (event.offline) this.#offlineKeys.set(`${event.offline.client_id}:${event.offline.client_seq}`, event);
  }

  eventsFor(aggregateType, aggregateId) {
    return this.#events.filter((e) => e.aggregate_type === aggregateType && e.aggregate_id === aggregateId);
  }

  /** 按离线客户端幂等键查找已接收事件（重传时返回同一事件，不产生第二个位置）。 */
  findOfflineEvent(clientId, clientSeq) {
    return this.#offlineKeys.get(`${clientId}:${clientSeq}`) ?? null;
  }
}
