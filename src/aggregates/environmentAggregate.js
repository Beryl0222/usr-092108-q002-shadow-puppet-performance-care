import { DomainError } from "../errors.js";

/**
 * 环境读数聚合（aggregate_type=environment_log）
 *
 * 一个场地/收纳点一条流，保留按时间排序的读数窗口。
 * 放行规则消费最近窗口：高湿（默认 >70%RH）或温度越界即否决老件上台。
 */
export const environmentAggregate = {
  aggregateType: "environment_log",
  aggregateId: (cmd) => cmd.location,
  initial: () => ({ location: null, readings: [] }),

  fold(state, event) {
    const p = event.payload ?? {};
    if (event.event_type === "ENVIRONMENT_RECORDED") {
      if (!state.location) state.location = p.location;
      state.readings.push({
        at: event.occurred_at,
        temp_c: p.temp_c,
        humidity_pct: p.humidity_pct,
        recorded_by: p.recorded_by,
        device_id: p.device_id,
        puppet_ids_present: [...p.puppet_ids_present],
      });
      state.readings.sort((a, b) => a.at.localeCompare(b.at));
    }
    return state;
  },

  handlers: {
    RecordEnvironment(state, cmd, ctx) {
      if (typeof cmd.temp_c !== "number" || typeof cmd.humidity_pct !== "number") {
        throw new DomainError("BAD_INPUT", "温湿度必须为数值");
      }
      if (cmd.humidity_pct < 0 || cmd.humidity_pct > 100) {
        throw new DomainError("BAD_INPUT", "湿度必须在 0–100%RH 之间");
      }
      return {
        eventType: "ENVIRONMENT_RECORDED",
        summary: `记录 ${cmd.location} 环境：${cmd.temp_c}℃ / ${cmd.humidity_pct}%RH`,
        payload: {
          location: cmd.location,
          temp_c: cmd.temp_c,
          humidity_pct: cmd.humidity_pct,
          recorded_by: ctx.actor.id,
          device_id: cmd.device_id,
          puppet_ids_present: cmd.puppet_ids_present ?? [],
        },
      };
    },
  },
};
