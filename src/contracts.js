/**
 * 领域事件契约目录：每一种事件绑定唯一聚合类型，并声明负载结构。
 * 契约只校验“形状”（字段、类型、枚举）；保全与排演的语义判断在各领域服务中。
 */
import { validateEvent } from "./validator.js";
import { ContractError } from "./errors.js";
import {
  PART_CONDITION,
  RELIC_GRADES,
  REHEARSAL_PURPOSES,
  TRAINING_DISCIPLINES,
} from "./policy.js";

const isString = (v) => typeof v === "string" && v.length > 0;

/** 生成 {类型, 必填, 枚举, 数值区间, 数组元素} 的声明式字段校验器。 */
function checkFields(spec, payload, path = "") {
  const errors = [];
  for (const [key, rule] of Object.entries(spec)) {
    const here = path ? `${path}.${key}` : key;
    const value = payload?.[key];
    if (value === undefined || value === null) {
      if (rule.required) errors.push(`缺少字段：${here}`);
      continue;
    }
    if (rule.type === "string") {
      if (!isString(value)) errors.push(`${here} 必须是非空字符串`);
      else if (rule.enum && !rule.enum.includes(value)) errors.push(`${here} 取值不被允许：${value}`);
    } else if (rule.type === "number") {
      if (typeof value !== "number" || Number.isNaN(value)) errors.push(`${here} 必须是数字`);
      else {
        if (rule.min !== undefined && value < rule.min) errors.push(`${here} 不得小于 ${rule.min}`);
        if (rule.max !== undefined && value > rule.max) errors.push(`${here} 不得大于 ${rule.max}`);
      }
    } else if (rule.type === "boolean") {
      if (typeof value !== "boolean") errors.push(`${here} 必须是布尔值`);
    } else if (rule.type === "array") {
      if (!Array.isArray(value)) errors.push(`${here} 必须是数组`);
      else if (value.length === 0 && rule.required) errors.push(`${here} 必须是非空数组`);
      else if (rule.itemType === "string" && value.some((v) => !isString(v)))
        errors.push(`${here} 的每一项都必须是非空字符串`);
      else if (rule.itemFields)
        value.forEach((item, i) => errors.push(...checkFields(rule.itemFields, item, `${here}[${i}]`)));
    } else if (rule.type === "object") {
      if (typeof value !== "object" || Array.isArray(value)) errors.push(`${here} 必须是对象`);
      else if (rule.fields) errors.push(...checkFields(rule.fields, value, here));
    }
  }
  return errors;
}

const partFinding = {
  part_id: { type: "string", required: true },
  condition: { type: "string", required: true, enum: Object.values(PART_CONDITION) },
  note: { type: "string", required: false },
};

/**
 * 事件目录。key 为 event_type；aggregate 指定该事件唯一允许的 aggregate_type，
 * fields 为负载（payload）契约。
 */
export const EVENT_CATALOG = Object.freeze({
  // —— 影偶实体、部件、修复、复制品 ——
  OBJECT_REGISTERED: {
    aggregate: "puppet_object",
    fields: {
      object_id: { type: "string", required: true },
      name: { type: "string", required: true },
      grade: { type: "string", required: true, enum: Object.values(RELIC_GRADES) },
      dynasty: { type: "string", required: false },
      year_estimate: { type: "string", required: false },
      registered_by: { type: "string", required: true },
      parts: {
        type: "array",
        required: true,
        itemFields: {
          part_id: { type: "string", required: true },
          name: { type: "string", required: true },
          condition: { type: "string", required: true, enum: Object.values(PART_CONDITION) },
        },
      },
    },
  },
  OBJECT_INSPECTED: {
    aggregate: "puppet_object",
    fields: {
      object_id: { type: "string", required: true },
      inspector_id: { type: "string", required: true },
      findings: { type: "array", required: true, itemFields: partFinding },
      note: { type: "string", required: false },
    },
  },
  DAMAGE_REPORTED: {
    aggregate: "puppet_object",
    fields: {
      object_id: { type: "string", required: true },
      reporter_id: { type: "string", required: true },
      findings: {
        type: "array",
        required: true,
        itemFields: {
          part_id: { type: "string", required: true },
          condition: {
            type: "string",
            required: true,
            enum: [PART_CONDITION.CRACKED, PART_CONDITION.WORM_EATEN, PART_CONDITION.BRITTLE],
          },
          note: { type: "string", required: false },
        },
      },
    },
  },
  PART_CLEARED: {
    aggregate: "puppet_object",
    fields: {
      object_id: { type: "string", required: true },
      part_id: { type: "string", required: true },
      inspector_id: { type: "string", required: true },
      note: { type: "string", required: false },
    },
  },
  REPAIR_RECORDED: {
    aggregate: "conservation_action",
    fields: {
      repair_id: { type: "string", required: true },
      object_id: { type: "string", required: true },
      part_id: { type: "string", required: true },
      restorer_id: { type: "string", required: true },
      apprentice_id: { type: "string", required: false },
      materials: { type: "array", required: true, itemType: "string" },
      techniques: { type: "array", required: true, itemType: "string" },
      note: { type: "string", required: false },
    },
  },
  REPERTOIRE_SET: {
    aggregate: "puppet_object",
    fields: {
      object_id: { type: "string", required: true },
      plays: { type: "array", required: true, itemType: "string" },
      updated_by: { type: "string", required: true },
    },
  },
  SUBSTITUTE_APPROVED: {
    aggregate: "puppet_object",
    fields: {
      object_id: { type: "string", required: true },
      replica_id: { type: "string", required: true },
      role_id: { type: "string", required: true },
      approved_by: { type: "string", required: true },
      note: { type: "string", required: false },
    },
  },

  // —— 环境 ——
  ENVIRONMENT_RECORDED: {
    aggregate: "environment_record",
    fields: {
      reading_id: { type: "string", required: true },
      location: { type: "string", required: true },
      humidity: { type: "number", required: true, min: 0, max: 100 },
      temperature: { type: "number", required: true, min: -40, max: 60 },
      recorded_by: { type: "string", required: true },
      performance_id: { type: "string", required: false },
    },
  },

  // —— 演出与排练 ——
  PERFORMANCE_PLANNED: {
    aggregate: "performance_plan",
    fields: {
      performance_id: { type: "string", required: true },
      title: { type: "string", required: true },
      venue: { type: "string", required: true },
      purpose: { type: "string", required: true, enum: Object.values(REHEARSAL_PURPOSES) },
      scheduled_start: { type: "string", required: true },
      scheduled_end: { type: "string", required: true },
      ticket_sold: { type: "boolean", required: true },
      planned_by: { type: "string", required: true },
    },
  },
  ROLE_CAST: {
    aggregate: "performance_plan",
    fields: {
      performance_id: { type: "string", required: true },
      role_id: { type: "string", required: true },
      role_name: { type: "string", required: true },
      object_id: { type: "string", required: true },
      operator_id: { type: "string", required: true },
      part_ids: { type: "array", required: false, itemType: "string" },
    },
  },
  STAGE_CLEARANCE_REQUESTED: {
    aggregate: "performance_plan",
    fields: {
      performance_id: { type: "string", required: true },
      role_id: { type: "string", required: true },
      object_id: { type: "string", required: true },
      reading_id: { type: "string", required: true },
      requested_by: { type: "string", required: true },
    },
  },
  CLEARANCE_GRANTED: {
    aggregate: "performance_plan",
    fields: {
      performance_id: { type: "string", required: true },
      role_id: { type: "string", required: true },
      object_id: { type: "string", required: true },
      granted_by: { type: "string", required: true },
      scope_part_ids: { type: "array", required: false, itemType: "string" },
      special_approval: {
        type: "object",
        required: false,
        fields: {
          reference: { type: "string", required: true },
          approver: { type: "string", required: true },
          reason: { type: "string", required: true },
        },
      },
    },
  },
  CLEARANCE_DENIED: {
    aggregate: "performance_plan",
    fields: {
      performance_id: { type: "string", required: true },
      role_id: { type: "string", required: true },
      object_id: { type: "string", required: true },
      decided_by: { type: "string", required: true },
      reasons: { type: "array", required: true, itemType: "string" },
    },
  },
  ROLE_SUBSTITUTED: {
    aggregate: "performance_plan",
    fields: {
      performance_id: { type: "string", required: true },
      role_id: { type: "string", required: true },
      from_object_id: { type: "string", required: true },
      to_object_id: { type: "string", required: true },
      reason: { type: "string", required: true },
      decided_by: { type: "string", required: true },
    },
  },
  PERFORMANCE_CLOSED: {
    aggregate: "performance_plan",
    fields: {
      performance_id: { type: "string", required: true },
      closed_by: { type: "string", required: true },
      note: { type: "string", required: false },
    },
  },

  // —— 借用与保管链 ——
  OBJECT_CHECKED_OUT: {
    aggregate: "custody_record",
    fields: {
      object_id: { type: "string", required: true },
      holder_id: { type: "string", required: true },
      holder_name: { type: "string", required: true },
      purpose: { type: "string", required: true },
      location: { type: "string", required: true },
      expected_return: { type: "string", required: false },
      handler_id: { type: "string", required: true },
    },
  },
  CUSTODY_TRANSFERRED: {
    aggregate: "custody_record",
    fields: {
      object_id: { type: "string", required: true },
      from_holder_id: { type: "string", required: true },
      to_holder_id: { type: "string", required: true },
      to_holder_name: { type: "string", required: true },
      location: { type: "string", required: true },
      handler_id: { type: "string", required: true },
      note: { type: "string", required: false },
    },
  },
  OBJECT_RETURNED: {
    aggregate: "custody_record",
    fields: {
      object_id: { type: "string", required: true },
      returned_by: { type: "string", required: true },
      received_by: { type: "string", required: true },
      location: { type: "string", required: true },
      complete: { type: "boolean", required: true },
      missing_part_ids: { type: "array", required: false, itemType: "string" },
      note: { type: "string", required: false },
    },
  },
  CUSTODY_DISPUTE_DETECTED: {
    aggregate: "custody_record",
    fields: {
      object_id: { type: "string", required: true },
      competing_event_ids: { type: "array", required: true, itemType: "string" },
      detail: { type: "string", required: true },
      detected_by: { type: "string", required: true },
    },
  },
  CUSTODY_RECONCILED: {
    aggregate: "custody_record",
    fields: {
      object_id: { type: "string", required: true },
      holder_id: { type: "string", required: false },
      location: { type: "string", required: true },
      reconciled_by: { type: "string", required: true },
      note: { type: "string", required: true },
    },
  },

  // —— 学徒资格 ——
  APPRENTICE_ENROLLED: {
    aggregate: "operator_clearance",
    fields: {
      apprentice_id: { type: "string", required: true },
      name: { type: "string", required: true },
      minor: { type: "boolean", required: true },
      master_id: { type: "string", required: true },
    },
  },
  TRAINING_LOGGED: {
    aggregate: "operator_clearance",
    fields: {
      apprentice_id: { type: "string", required: true },
      discipline: { type: "string", required: true, enum: Object.values(TRAINING_DISCIPLINES) },
      level: { type: "string", required: true },
      logged_by: { type: "string", required: true },
      note: { type: "string", required: false },
    },
  },
  TRAINING_REVIEWED: {
    aggregate: "operator_clearance",
    fields: {
      apprentice_id: { type: "string", required: true },
      discipline: { type: "string", required: true, enum: Object.values(TRAINING_DISCIPLINES) },
      level: { type: "string", required: true },
      reviewer_id: { type: "string", required: true },
      passed: { type: "boolean", required: true },
      note: { type: "string", required: false },
    },
  },
  QUALIFICATION_GRANTED: {
    aggregate: "operator_clearance",
    fields: {
      apprentice_id: { type: "string", required: true },
      discipline: { type: "string", required: true, enum: Object.values(TRAINING_DISCIPLINES) },
      level: { type: "string", required: true },
      granted_by: { type: "string", required: true },
    },
  },
});

export const EVENT_TYPES = Object.freeze(Object.keys(EVENT_CATALOG));

/**
 * 校验一条待接收事件的完整契约：信封 + 事件类型已知 + 聚合匹配 + 负载结构。
 * 离线事件允许在信封上携带 offline 链信息（client_id / client_seq / previous_event_id）。
 * @throws {ContractError}
 */
export function assertValidContract(event) {
  const envelopeErrors = validateEvent(event);
  const errors = [...envelopeErrors];
  const spec = EVENT_CATALOG[event.event_type];
  if (!spec) {
    errors.push(`未知事件类型：${event.event_type}`);
  } else {
    if (event.aggregate_type !== spec.aggregate) {
      errors.push(`${event.event_type} 的 aggregate_type 必须是 ${spec.aggregate}`);
    }
    errors.push(...checkFields(spec.fields, event.payload ?? {}, "payload"));
    const offline = event.offline;
    if (offline !== undefined) {
      if (typeof offline !== "object" || Array.isArray(offline)) errors.push("offline 必须是对象");
      else {
        if (!isString(offline.client_id)) errors.push("offline.client_id 必须是非空字符串");
        if (!Number.isInteger(offline.client_seq) || offline.client_seq < 1)
          errors.push("offline.client_seq 必须是正整数");
        if (
          offline.previous_event_id !== undefined &&
          offline.previous_event_id !== null &&
          !isString(offline.previous_event_id)
        )
          errors.push("offline.previous_event_id 必须是非空字符串");
      }
    }
  }
  if (errors.length) throw new ContractError("事件契约不合法", { errors });
}
