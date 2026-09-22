/**
 * 读模型投影：把追加式事件流折叠成各角色需要的当前状态。
 * 投影是纯函数式折叠——不做业务判断，只如实反映事件；所有更正也体现为新的状态层，
 * 历史数组只追加、不覆盖。
 */
import { PART_CONDITION, STAGE_READY_CONDITIONS, TRAINING_LEVELS } from "./policy.js";

export class Projection {
  constructor() {
    this.reset();
  }

  reset() {
    /** @type {Map<string, object>} 影偶（含复制品），按 object_id */
    this.objects = new Map();
    /** @type {Map<string, object>} 环境读数，按 reading_id */
    this.environmentReadings = new Map();
    /** @type {Map<string, object>} 演出计划，按 performance_id */
    this.performances = new Map();
    /** @type {Map<string, object>} 每件影偶的保管链，按 object_id */
    this.custody = new Map();
    /** @type {Map<string, object>} 学徒资格档案，按 apprentice_id */
    this.apprentices = new Map();
  }

  rebuild(events) {
    this.reset();
    // 按追加（入链）顺序折叠：离线事件以其同步入链的位置为准，
    // 保证重建结果与实时投影一致；事件真实发生时间仍保留在 occurred_at 中。
    for (const e of events) {
      this.apply(e);
    }
    return this;
  }

  apply(e) {
    const p = e.payload ?? {};
    switch (e.event_type) {
      case "OBJECT_REGISTERED": {
        this.objects.set(p.object_id, {
          object_id: p.object_id,
          name: p.name,
          grade: p.grade,
          dynasty: p.dynasty ?? null,
          year_estimate: p.year_estimate ?? null,
          registered_by: p.registered_by,
          registered_at: e.occurred_at,
          repertoire: [],
          parts: new Map(
            p.parts.map((part) => [
              part.part_id,
              {
                part_id: part.part_id,
                name: part.name,
                condition: part.condition,
                frozen: !STAGE_READY_CONDITIONS.has(part.condition),
                history: [
                  { kind: "登记", condition: part.condition, at: e.occurred_at, event_id: e.event_id },
                ],
              },
            ])
          ),
          /** 修复层次：只追加，每层保留材料与手法 */
          repairs: [],
          /** 获准替身：replica_id -> 可替角色集合 */
          substitutes: new Map(),
        });
        break;
      }

      case "REPERTOIRE_SET": {
        const obj = this.objects.get(p.object_id);
        if (obj) obj.repertoire = [...p.plays];
        break;
      }

      case "OBJECT_INSPECTED":
      case "DAMAGE_REPORTED": {
        const obj = this.objects.get(p.object_id);
        if (!obj) break;
        for (const finding of p.findings) {
          const part = obj.parts.get(finding.part_id);
          if (!part) continue;
          part.condition = finding.condition;
          // 只冻结报损部件；同件其他完好部件不受株连
          part.frozen = !STAGE_READY_CONDITIONS.has(finding.condition);
          part.history.push({
            kind: e.event_type === "DAMAGE_REPORTED" ? "损伤上报" : "巡检",
            condition: finding.condition,
            note: finding.note ?? "",
            by: p.reporter_id ?? p.inspector_id,
            at: e.occurred_at,
            event_id: e.event_id,
          });
        }
        break;
      }

      case "REPAIR_RECORDED": {
        const obj = this.objects.get(p.object_id);
        if (!obj) break;
        const layer = {
          repair_id: p.repair_id,
          part_id: p.part_id,
          restorer_id: p.restorer_id,
          apprentice_id: p.apprentice_id ?? null,
          materials: [...p.materials],
          techniques: [...p.techniques],
          note: p.note ?? "",
          at: e.occurred_at,
          event_id: e.event_id,
        };
        obj.repairs.push(layer); // 返工是新的一层，旧层次原样保留
        const part = obj.parts.get(p.part_id);
        if (part) {
          part.condition = PART_CONDITION.REPAIRED;
          part.frozen = true; // 待复检前仍然冻结
          part.history.push({
            kind: "修复",
            condition: PART_CONDITION.REPAIRED,
            repair_id: p.repair_id,
            by: p.restorer_id,
            at: e.occurred_at,
            event_id: e.event_id,
          });
        }
        break;
      }

      case "PART_CLEARED": {
        const obj = this.objects.get(p.object_id);
        const part = obj?.parts.get(p.part_id);
        if (part) {
          part.condition = PART_CONDITION.SOUND;
          part.frozen = false;
          part.history.push({
            kind: "复检解冻",
            condition: PART_CONDITION.SOUND,
            by: p.inspector_id,
            note: p.note ?? "",
            at: e.occurred_at,
            event_id: e.event_id,
          });
        }
        break;
      }

      case "SUBSTITUTE_APPROVED": {
        const obj = this.objects.get(p.object_id);
        if (!obj) break;
        const roles = obj.substitutes.get(p.replica_id) ?? new Set();
        roles.add(p.role_id);
        obj.substitutes.set(p.replica_id, roles);
        break;
      }

      case "ENVIRONMENT_RECORDED": {
        this.environmentReadings.set(p.reading_id, { ...p, at: e.occurred_at });
        break;
      }

      case "PERFORMANCE_PLANNED": {
        this.performances.set(p.performance_id, {
          performance_id: p.performance_id,
          title: p.title,
          venue: p.venue,
          purpose: p.purpose,
          scheduled_start: p.scheduled_start,
          scheduled_end: p.scheduled_end,
          ticket_sold: p.ticket_sold,
          status: "已排期",
          roles: new Map(),
        });
        break;
      }

      case "ROLE_CAST": {
        const show = this.performances.get(p.performance_id);
        if (!show) break;
        const role = show.roles.get(p.role_id) ?? {
          role_id: p.role_id,
          role_name: p.role_name,
          casts: [],
          clearances: [],
        };
        role.casts.push({
          object_id: p.object_id,
          operator_id: p.operator_id,
          part_ids: p.part_ids ? [...p.part_ids] : null,
          at: e.occurred_at,
          event_id: e.event_id,
        });
        role.current = role.casts[role.casts.length - 1];
        show.roles.set(p.role_id, role);
        break;
      }

      case "STAGE_CLEARANCE_REQUESTED": {
        const show = this.performances.get(p.performance_id);
        const role = show?.roles.get(p.role_id);
        if (role) {
          role.pending_request = { ...p, at: e.occurred_at, event_id: e.event_id };
        }
        break;
      }

      case "CLEARANCE_GRANTED":
      case "CLEARANCE_DENIED": {
        const show = this.performances.get(p.performance_id);
        const role = show?.roles.get(p.role_id);
        if (!role) break;
        const granted = e.event_type === "CLEARANCE_GRANTED";
        role.clearances.push({
          granted,
          object_id: p.object_id,
          by: granted ? p.granted_by : p.decided_by,
          reasons: granted ? null : [...p.reasons],
          scope_part_ids: granted && p.scope_part_ids ? [...p.scope_part_ids] : null,
          special_approval: granted ? p.special_approval ?? null : null,
          at: e.occurred_at,
          event_id: e.event_id,
        });
        role.latest_clearance = role.clearances[role.clearances.length - 1];
        role.pending_request = null;
        break;
      }

      case "ROLE_SUBSTITUTED": {
        const show = this.performances.get(p.performance_id);
        const role = show?.roles.get(p.role_id);
        if (!role) break;
        role.current = {
          ...(role.current ?? {}),
          object_id: p.to_object_id,
          substituted: true,
        };
        role.substitutions = role.substitutions ?? [];
        role.substitutions.push({
          from_object_id: p.from_object_id,
          to_object_id: p.to_object_id,
          reason: p.reason,
          by: p.decided_by,
          at: e.occurred_at,
          event_id: e.event_id,
        });
        // 换角后旧许可不再覆盖新影偶，需重新核验
        role.latest_clearance = null;
        break;
      }

      case "PERFORMANCE_CLOSED": {
        const show = this.performances.get(p.performance_id);
        if (show) show.status = "已收场";
        break;
      }

      case "OBJECT_CHECKED_OUT":
      case "CUSTODY_TRANSFERRED":
      case "OBJECT_RETURNED":
      case "CUSTODY_DISPUTE_DETECTED":
      case "CUSTODY_RECONCILED":
        applyCustody(this.custody, e);
        break;

      case "APPRENTICE_ENROLLED": {
        this.apprentices.set(p.apprentice_id, {
          apprentice_id: p.apprentice_id,
          name: p.name,
          minor: p.minor,
          master_id: p.master_id,
          enrolled_at: e.occurred_at,
          /** discipline -> level -> { logged_at, reviews: [], qualified_at } */
          training: {},
          qualifications: [],
        });
        break;
      }

      case "TRAINING_LOGGED": {
        const app = this.apprentices.get(p.apprentice_id);
        if (!app) break;
        const disc = (app.training[p.discipline] ??= {});
        disc[p.level] = {
          ...(disc[p.level] ?? {}),
          logged_at: e.occurred_at,
          logged_by: p.logged_by,
          log_note: p.note ?? "",
          reviews: disc[p.level]?.reviews ?? [],
        };
        break;
      }

      case "TRAINING_REVIEWED": {
        const app = this.apprentices.get(p.apprentice_id);
        const levelState = app?.training[p.discipline]?.[p.level];
        if (!levelState) break;
        levelState.reviews.push({
          reviewer_id: p.reviewer_id,
          passed: p.passed,
          note: p.note ?? "",
          at: e.occurred_at,
          event_id: e.event_id,
        });
        break;
      }

      case "QUALIFICATION_GRANTED": {
        const app = this.apprentices.get(p.apprentice_id);
        if (!app) break;
        const levelState = app.training[p.discipline]?.[p.level];
        if (levelState) levelState.qualified_at = e.occurred_at;
        app.qualifications.push({
          discipline: p.discipline,
          level: p.level,
          granted_by: p.granted_by,
          at: e.occurred_at,
          event_id: e.event_id,
        });
        break;
      }

      default:
        break;
    }
  }
}

/** 保管链折叠：争议期间位置冻结为“位置争议”，不接受任何一方的说法作为当前位置。 */
function applyCustody(custody, e) {
  const p = e.payload ?? {};
  const chain =
    custody.get(p.object_id) ??
    {
      object_id: p.object_id,
      current: null,
      disputed: false,
      history: [],
      disputes: [],
    };

  switch (e.event_type) {
    case "OBJECT_CHECKED_OUT":
      chain.current = {
        holder_id: p.holder_id,
        holder_name: p.holder_name,
        location: p.location,
        purpose: p.purpose,
        since: e.occurred_at,
        event_id: e.event_id,
      };
      chain.history.push({ kind: "借出", ...chain.current });
      break;
    case "CUSTODY_TRANSFERRED":
      chain.current = {
        holder_id: p.to_holder_id,
        holder_name: p.to_holder_name,
        location: p.location,
        purpose: "交接",
        since: e.occurred_at,
        event_id: e.event_id,
      };
      chain.history.push({
        kind: "交接",
        from_holder_id: p.from_holder_id,
        ...chain.current,
        note: p.note ?? "",
      });
      break;
    case "OBJECT_RETURNED":
      chain.current = {
        holder_id: null,
        holder_name: "库房",
        location: p.location,
        purpose: "已归还",
        complete: p.complete,
        since: e.occurred_at,
        event_id: e.event_id,
      };
      chain.history.push({
        kind: "归还",
        returned_by: p.returned_by,
        received_by: p.received_by,
        ...chain.current,
        missing_part_ids: p.missing_part_ids ? [...p.missing_part_ids] : [],
        note: p.note ?? "",
      });
      break;
    case "CUSTODY_DISPUTE_DETECTED":
      chain.disputed = true;
      chain.current = {
        holder_id: null,
        holder_name: "位置争议（待复核）",
        location: "位置争议（待复核）",
        since: e.occurred_at,
        event_id: e.event_id,
      };
      chain.disputes.push({
        competing_event_ids: [...p.competing_event_ids],
        detail: p.detail,
        detected_by: p.detected_by,
        at: e.occurred_at,
        event_id: e.event_id,
        resolved: false,
      });
      break;
    case "CUSTODY_RECONCILED": {
      chain.disputed = false;
      const open = [...chain.disputes].reverse().find((d) => !d.resolved);
      if (open) open.resolved = true;
      chain.current = {
        holder_id: p.holder_id ?? null,
        holder_name: p.holder_id ? chain.current?.holder_name ?? p.holder_id : "库房",
        location: p.location,
        purpose: "复核归位",
        since: e.occurred_at,
        event_id: e.event_id,
      };
      chain.history.push({
        kind: "复核归位",
        ...chain.current,
        reconciled_by: p.reconciled_by,
        note: p.note,
      });
      break;
    }
    default:
      break;
  }
  custody.set(p.object_id, chain);
}

/** 学徒是否已取得某科的独立资格（末级已授权）。 */
export function hasIndependentQualification(apprentice, discipline, independentLevel) {
  const lvl = apprentice?.training[discipline]?.[independentLevel];
  return Boolean(lvl?.qualified_at);
}

/** 某科当前“已通过师傅复核”的最高层级序号（供能力视图使用）。 */
export function highestReviewedLevel(apprentice, discipline) {
  const ladder = TRAINING_LEVELS[discipline];
  const disc = apprentice?.training[discipline];
  if (!disc) return -1;
  let highest = -1;
  ladder.forEach((level, i) => {
    const reviews = disc[level]?.reviews ?? [];
    if (reviews.some((r) => r.passed)) highest = i;
  });
  return highest;
}
