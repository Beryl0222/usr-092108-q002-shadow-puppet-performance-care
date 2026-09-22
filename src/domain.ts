/**
 * 皮影古件演出保全 · 领域事件定义
 *
 * 事件只追加、不改写：标识、发生时间与版本一经接收即固定；
 * 业务更正必须产生后继事件（如解冻、撤回授权、计划取消）。
 *
 * 版本说明：version 为该聚合实例内的事件序号，从 1 起逐条递增；
 * 离线批次同步时以 (aggregate_id, version) 做幂等与冲突判定。
 */

// ---------------------------------------------------------------------------
// 共用枚举
// ---------------------------------------------------------------------------

export type ArtifactClass = "antique" | "replica";

export type Role =
  | "company_lead" // 剧团负责人
  | "performance_manager" // 演出经理
  | "conservator" // 修缮师
  | "inheritor" // 传承人（师傅）
  | "apprentice"; // 学徒

/** 部件保全状态：完好 / 观察 / 冻结（不可上台、不可出库）。 */
export type PartStatus = "ok" | "watch" | "frozen";

/** 观察到的损伤类型。 */
export type DamageKind = "crack" | "worm" | "fracture" | "surface_wear" | "loose_joint" | "other";

/** 道具允许接触级别：authentic 老件 / replica 仅限复制品。 */
export type HandlingLevel = "authentic" | "replica";

/** 计划场合。 */
export type OccasionKind = "festival" | "village" | "training" | "rehearsal" | "other";

/** 计划条目状态。 */
export type PlanItemStatus = "scheduled" | "cleared" | "blocked" | "substituted" | "cancelled";

/** 学徒资格能力域。 */
export type Competency = "manipulation" | "crafting" | "repair";

/** 资格级别：未入门 → 在训 → 监督下 → 可独立（真实能力达成）。 */
export type QualificationStage = "none" | "trainee" | "supervised" | "independent";

/** 放行决策结果。 */
export type ClearanceDecision = "cleared" | "blocked";

/** 借用条目的当前环节。 */
export type LoanStatus = "checked_out" | "in_transfer" | "returned" | "missing";

// ---------------------------------------------------------------------------
// 事件信封
// ---------------------------------------------------------------------------

export interface DomainEventBase {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: string; // RFC 3339
  version: number; // 聚合内版本，>=1
  summary: string;
  /** 关联事件（因果链）：如冻结对应巡检、解冻对应检验。 */
  caused_by?: string[];
  /** 现场离线记录时携带的批次标识，便于多设备交接后对账。 */
  sync_batch_id?: string;
  /** 产生该事件时已知的该聚合最新版本（乐观并发/离线分叉检测）。 */
  expected_version?: number;
}

// ---------------------------------------------------------------------------
// 载荷：影偶与部件
// ---------------------------------------------------------------------------

export interface PuppetRegisteredPayload {
  puppet_id: string;
  name: string;
  artifact_class: ArtifactClass;
  /** 断代，例如 "明代·约1600年"；四百多年老件填写可考年代。 */
  dating: string;
  acquired_at?: string;
  note?: string;
}

export interface PartRegisteredPayload {
  part_id: string;
  puppet_id: string;
  name: string;
  initial_status?: PartStatus;
  note?: string;
}

export interface DamageObservedPayload {
  puppet_id: string;
  part_id: string;
  damage_kind: DamageKind;
  severity: 1 | 2 | 3;
  description: string;
  observed_by: string;
  /**
   * 是否仅冻结该部件。true（默认）时同一影偶其余部件仍可使用；
   * 只有结构性断裂且整体无法安全登场时才置 false 冻结整偶。
   */
  part_only: boolean;
  image_refs?: string[];
}

export interface PartFrozenPayload {
  puppet_id: string;
  part_id: string;
  reason: string;
  damage_event_id: string;
}

export interface RepairLayerAddedPayload {
  puppet_id: string;
  part_id: string;
  repair_id: string;
  layer_no: number;
  materials: string[];
  techniques: string[];
  conservator_id: string;
  note?: string;
}

export interface PartReturnedToServicePayload {
  puppet_id: string;
  part_id: string;
  inspection_id: string;
  condition_note: string;
  /** 检验后状态：watch 表示继续观察，ok 表示恢复使用。 */
  resulting_status: Exclude<PartStatus, "frozen">;
}

export interface SubstituteRegisteredPayload {
  /** 替身自身也是一个 puppet_object（artifact_class=replica）。 */
  replica_puppet_id: string;
  name: string;
  /** 被替代的老件。 */
  antique_puppet_id: string;
  /** 替身可覆盖的老件部件；空表示整偶替身。 */
  covers_part_ids: string[];
  /** 经核准可顶替的剧目与角色。 */
  approved_roles: Array<{ play_id: string; role: string }>;
  approved_by: string;
}

export interface PlayableRoleDeclaredPayload {
  puppet_id: string;
  play_id: string;
  role: string;
}

export interface HandlingLevelSetPayload {
  puppet_id: string;
  handling_level: HandlingLevel;
  reason: string;
}

// ---------------------------------------------------------------------------
// 载荷：环境
// ---------------------------------------------------------------------------

export interface EnvironmentRecordedPayload {
  location: string;
  temp_c: number;
  humidity_pct: number;
  recorded_by: string;
  device_id?: string;
  /** 在场影偶（环境窗口影响这些物件的放行）。 */
  puppet_ids_present: string[];
}

// ---------------------------------------------------------------------------
// 载荷：演出 / 排练计划
// ---------------------------------------------------------------------------

export interface PerformancePlannedPayload {
  plan_id: string;
  occasion: OccasionKind;
  title: string;
  venue: string;
  starts_at: string;
  /** 是否已售票；售票不构成放行理由，仅用于提示经理风险。 */
  tickets_sold: boolean;
  items: Array<{
    item_id: string;
    play_id: string;
    role: string;
    puppet_id: string;
    part_ids?: string[];
  }>;
  planned_by: string;
}

export interface PlaySwappedPayload {
  plan_id: string;
  item_id: string;
  from_play_id: string;
  to_play_id: string;
  to_role: string;
  swapped_by: string;
  reason: string;
}

export interface CastingChangedPayload {
  plan_id: string;
  item_id: string;
  puppet_id: string;
  part_ids?: string[];
  changed_by: string;
  reason: string;
}

export interface OperatorAssignedPayload {
  plan_id: string;
  item_id: string;
  operator_id: string;
  operator_supervised: boolean;
}

export interface ClearanceEvaluatedPayload {
  plan_id: string;
  item_id: string;
  puppet_id: string;
  decision: ClearanceDecision;
  reasons: string[];
  /** 命中冻结部件时，建议且需后续显式指派的核准替身。 */
  suggested_replica_puppet_id?: string;
  evaluated_by: string;
}

export interface StageAuthorizationGrantedPayload {
  plan_id: string;
  item_id: string;
  puppet_id: string;
  granted_by: string;
  scope: string;
}

export interface StageUseBlockedPayload {
  plan_id: string;
  item_id: string;
  puppet_id: string;
  reasons: string[];
}

export interface SubstituteAssignedPayload {
  plan_id: string;
  item_id: string;
  antique_puppet_id: string;
  replica_puppet_id: string;
  approved_for: { play_id: string; role: string };
  assigned_by: string;
}

export interface PlanCancelledPayload {
  plan_id: string;
  reason: string;
  cancelled_by: string;
}

// ---------------------------------------------------------------------------
// 载荷：借用 / 交接 / 归还
// ---------------------------------------------------------------------------

export interface LoanCheckedOutPayload {
  loan_id: string;
  puppet_id: string;
  custodian_id: string;
  purpose: string;
  expected_return_at?: string;
}

export interface CustodyTransferredPayload {
  loan_id: string;
  puppet_id: string;
  from_custodian_id: string;
  to_custodian_id: string;
  handoff_note: string;
}

export interface LoanReturnedPayload {
  loan_id: string;
  puppet_id: string;
  returned_by: string;
  condition_note: string;
  /** 归还清点逐部件确认。 */
  parts_checked: Array<{ part_id: string; present: boolean; note?: string }>;
}

export interface ItemMarkedMissingPayload {
  loan_id: string;
  puppet_id: string;
  note: string;
}

export interface CustodyConflictDetectedPayload {
  puppet_id: string;
  loan_id: string;
  conflict: string;
  rejected_event_ids: string[];
}

// ---------------------------------------------------------------------------
// 载荷：学徒资格
// ---------------------------------------------------------------------------

export interface ApprenticeEnrolledPayload {
  apprentice_id: string;
  name: string;
  minor: boolean;
  enrolled_by: string;
}

export interface TrainingLevelRecordedPayload {
  apprentice_id: string;
  competency: Competency;
  stage: QualificationStage;
  layer: number;
  note?: string;
  recorded_by: string;
}

export interface MasterReviewPassedPayload {
  apprentice_id: string;
  competency: Competency;
  reviewer_id: string;
  note?: string;
}

export interface HandlingPrivilegeGrantedPayload {
  apprentice_id: string;
  handling_level: HandlingLevel;
  granted_by: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// 载荷：保全行动（管理用）
// ---------------------------------------------------------------------------

export interface ConservationActionOpenedPayload {
  action_id: string;
  puppet_id: string;
  part_id?: string;
  title: string;
  opened_by: string;
  linked_damage_event_id?: string;
}

export interface ConservationActionClosedPayload {
  action_id: string;
  result_note: string;
  closed_by: string;
}

// ---------------------------------------------------------------------------
// 事件联合
// ---------------------------------------------------------------------------

export interface DomainEvent extends DomainEventBase {
  event_type:
    | "OBJECT_REGISTERED"
    | "PART_REGISTERED"
    | "DAMAGE_OBSERVED"
    | "PART_FROZEN"
    | "REPAIR_LAYER_ADDED"
    | "PART_RETURNED_TO_SERVICE"
    | "SUBSTITUTE_REGISTERED"
    | "PLAYABLE_ROLE_DECLARED"
    | "HANDLING_LEVEL_SET"
    | "ENVIRONMENT_RECORDED"
    | "PERFORMANCE_PLANNED"
    | "PLAY_SWAPPED"
    | "CASTING_CHANGED"
    | "OPERATOR_ASSIGNED"
    | "CLEARANCE_EVALUATED"
    | "STAGE_AUTHORIZATION_GRANTED"
    | "STAGE_USE_BLOCKED"
    | "SUBSTITUTE_ASSIGNED"
    | "PLAN_CANCELLED"
    | "LOAN_CHECKED_OUT"
    | "CUSTODY_TRANSFERRED"
    | "LOAN_RETURNED"
    | "ITEM_MARKED_MISSING"
    | "CUSTODY_CONFLICT_DETECTED"
    | "APPRENTICE_ENROLLED"
    | "TRAINING_LEVEL_RECORDED"
    | "MASTER_REVIEW_PASSED"
    | "HANDLING_PRIVILEGE_GRANTED"
    | "CONSERVATION_ACTION_OPENED"
    | "CONSERVATION_ACTION_CLOSED"
    // 向后兼容：信封层保留旧名称
    | "OBJECT_INSPECTED"
    | "REPAIR_RECORDED"
    | "CLEARANCE_GRANTED";
  aggregate_type:
    | "puppet_object"
    | "performance_plan"
    | "conservation_action"
    | "operator_clearance"
    | "loan_record"
    | "apprentice_clearance"
    | "environment_log";
  payload?: Record<string, unknown>;
}
