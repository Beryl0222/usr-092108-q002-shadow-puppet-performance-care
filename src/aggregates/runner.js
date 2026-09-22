import { EventStore, newEventId } from "../store/eventStore.js";
import { DomainError } from "../errors.js";

/**
 * 通用聚合运行器：加载事件流 → fold 状态 → 命令处理器产生事件描述符 →
 * 分配版本并一次性原子追加。
 *
 * 事件描述符：{ eventType, summary, payload, aggregateId?, causedBy? }
 * 绝大多数命令只写当前聚合流；aggregateId 覆盖仅用于跨流极少数场景。
 */
export function runCommand(store, def, command, context = {}) {
  const aggregateId = def.aggregateId(command);
  const streamKey = EventStore.streamKey(def.aggregateType, aggregateId);
  const history = store.load(streamKey);
  let state = def.initial();
  for (const event of history) state = def.fold(state, event);

  const handler = def.handlers[command.type];
  if (!handler) throw new DomainError("UNKNOWN_COMMAND", `不支持的命令：${command.type}`);

  const ctx = {
    actor: context.actor ?? { id: "system", roles: [] },
    at: context.at ?? new Date().toISOString(),
    batchId: context.batchId,
    // 跨聚合只读查询（如放行时查阅部件状态、环境、学徒资格）
    registry: context.registry,
    state,
  };
  const descriptors = asArray(handler(state, command, ctx)) ?? [];
  if (descriptors.length === 0) return [];

  let nextVersion = history.length;
  const events = descriptors.map((d) => {
    nextVersion += 1;
    const targetAggregateId = d.aggregateId ?? aggregateId;
    if (d.aggregateId && d.aggregateId !== aggregateId) {
      throw new DomainError("CROSS_STREAM", "当前运行器不支持跨流写入，请改用应用服务");
    }
    return {
      event_id: d.eventId ?? newEventId(def.aggregateType.slice(0, 3)),
      event_type: d.eventType,
      aggregate_type: def.aggregateType,
      aggregate_id: targetAggregateId,
      occurred_at: d.occurredAt ?? ctx.at,
      version: nextVersion,
      summary: d.summary,
      payload: d.payload ?? {},
      ...(d.causedBy ? { caused_by: d.causedBy } : {}),
      ...(ctx.batchId ? { sync_batch_id: ctx.batchId } : {}),
      ...(context.expectedVersion !== undefined ? { expected_version: context.expectedVersion } : {}),
    };
  });

  store.append(streamKey, events, context.expectedVersion);
  return events;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function requireRole(ctx, roles, action) {
  const held = new Set(ctx.actor.roles ?? []);
  if (!roles.some((r) => held.has(r))) {
    throw new DomainError(
      "FORBIDDEN",
      `${ctx.actor.id} 无权执行「${action}」，需要角色：${roles.join(" / ")}`,
    );
  }
}

export function requireExists(state, id, label) {
  if (!state) throw new DomainError("NOT_FOUND", `${label}不存在：${id}`);
}
