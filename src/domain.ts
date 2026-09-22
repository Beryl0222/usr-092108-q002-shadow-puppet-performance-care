/**
 * 皮影古件演出保全领域类型。
 * 事件只追加、不改写；以下接口描述事件信封与各类负载的形状，语义规则见 src/services。
 */

/** 领域事件共同信封（既有约定，保持兼容）。 */
export interface DomainEvent {
  event_id: string;
  event_type: DomainEventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  payload?: EventPayload;
  /** 离线终端记录时携带的链信息，用于幂等与分叉检测。 */
  offline?: {
    client_id: string;
    client_seq: number;
    previous_event_id?: string | null;
  };
}

export type AggregateType =
  | "puppet_object"
  | "performance_plan"
  | "conservation_action"
  | "operator_clearance"
  | "environment_record"
  | "custody_record";

export type DomainEventType =
  // 影偶/部件/修复/替身
  | "OBJECT_REGISTERED"
  | "OBJECT_INSPECTED"
  | "DAMAGE_REPORTED"
  | "PART_CLEARED"
  | "REPAIR_RECORDED"
  | "REPERTOIRE_SET"
  | "SUBSTITUTE_APPROVED"
  // 环境
  | "ENVIRONMENT_RECORDED"
  // 演出排演
  | "PERFORMANCE_PLANNED"
  | "ROLE_CAST"
  | "STAGE_CLEARANCE_REQUESTED"
  | "CLEARANCE_GRANTED"
  | "CLEARANCE_DENIED"
  | "ROLE_SUBSTITUTED"
  | "PERFORMANCE_CLOSED"
  // 保管链
  | "OBJECT_CHECKED_OUT"
  | "CUSTODY_TRANSFERRED"
  | "OBJECT_RETURNED"
  | "CUSTODY_DISPUTE_DETECTED"
  | "CUSTODY_RECONCILED"
  // 学徒资格
  | "APPRENTICE_ENROLLED"
  | "TRAINING_LOGGED"
  | "TRAINING_REVIEWED"
  | "QUALIFICATION_GRANTED";

export type RelicGrade = "一级文物" | "二级文物" | "一般文物" | "现代道具" | "核准复制品";
export type PartCondition = "完好" | "开裂" | "虫蛀" | "酥脆" | "已修复待复检";
export type HandlingLevel = "仅复制品" | "现代及一般文物" | "二级文物" | "一级文物（师傅在场）";
export type Discipline = "操控" | "制作" | "修补";

interface EventPayload {
  [key: string]: unknown;
}

/** 上台许可三因子评估结果。 */
export interface StageVerdict {
  can_go_ahead: boolean;
  object_id: string;
  objectName: string;
  grade: RelicGrade;
  checked_part_ids: string[];
  /** 售票状态被显式带回但从不参与结论。 */
  ticket_sold: boolean | null;
  reasons: string[];
}
