import { ContractError } from "./errors.js";

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

/** 仅校验共同信封；业务规则在各聚合内校验。 */
export function validateEvent(record) {
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("occurred_at" in record && Number.isNaN(Date.parse(record.occurred_at))) {
    errors.push("occurred_at 必须是合法的 date-time");
  }
  if (record && typeof record.event_type === "string" && typeof record.aggregate_type === "string") {
    const aggregateOf = EVENT_AGGREGATE[record.event_type];
    if (aggregateOf && aggregateOf !== record.aggregate_type) {
      errors.push(`事件 ${record.event_type} 的聚合必须是 ${aggregateOf}`);
    }
  }
  return errors;
}

export function assertValidEnvelope(record) {
  const errors = validateEvent(record);
  if (errors.length > 0) throw new ContractError(errors.join("；"));
}

/** 事件类型与所属聚合的对应表（信封层约束）。 */
export const EVENT_AGGREGATE = {
  OBJECT_REGISTERED: "puppet_object",
  PART_REGISTERED: "puppet_object",
  DAMAGE_OBSERVED: "puppet_object",
  PART_FROZEN: "puppet_object",
  REPAIR_LAYER_ADDED: "puppet_object",
  PART_RETURNED_TO_SERVICE: "puppet_object",
  SUBSTITUTE_REGISTERED: "puppet_object",
  PLAYABLE_ROLE_DECLARED: "puppet_object",
  HANDLING_LEVEL_SET: "puppet_object",
  ENVIRONMENT_RECORDED: "environment_log",
  PERFORMANCE_PLANNED: "performance_plan",
  PLAY_SWAPPED: "performance_plan",
  CASTING_CHANGED: "performance_plan",
  OPERATOR_ASSIGNED: "performance_plan",
  CLEARANCE_EVALUATED: "performance_plan",
  STAGE_AUTHORIZATION_GRANTED: "performance_plan",
  STAGE_USE_BLOCKED: "performance_plan",
  SUBSTITUTE_ASSIGNED: "performance_plan",
  PLAN_CANCELLED: "performance_plan",
  LOAN_CHECKED_OUT: "loan_record",
  CUSTODY_TRANSFERRED: "loan_record",
  LOAN_RETURNED: "loan_record",
  ITEM_MARKED_MISSING: "loan_record",
  CUSTODY_CONFLICT_DETECTED: "loan_record",
  APPRENTICE_ENROLLED: "apprentice_clearance",
  TRAINING_LEVEL_RECORDED: "apprentice_clearance",
  MASTER_REVIEW_PASSED: "apprentice_clearance",
  HANDLING_PRIVILEGE_GRANTED: "apprentice_clearance",
  CONSERVATION_ACTION_OPENED: "conservation_action",
  CONSERVATION_ACTION_CLOSED: "conservation_action",
  // 向后兼容的旧事件名，不限定聚合
  OBJECT_INSPECTED: null,
  REPAIR_RECORDED: null,
  CLEARANCE_GRANTED: null,
};
