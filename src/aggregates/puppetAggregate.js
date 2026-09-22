import { DomainError } from "../errors.js";
import { requireRole } from "./runner.js";

/**
 * 影偶保全聚合（aggregate_type=puppet_object）
 *
 * 关键不变量：
 *  - 损伤只冻结相关部件；整偶冻结仅在 part_only=false（结构性断裂）时发生。
 *  - 修复以“层”追加，layer_no 在部件内连续编号，永不覆盖旧层。
 *  - 修复本身不解冻；必须经检验 PART_RETURNED_TO_SERVICE 才能恢复使用。
 *  - 替身是独立的 replica 物件，须显式核准可顶替的剧目/角色。
 */
export const puppetAggregate = {
  aggregateType: "puppet_object",
  aggregateId: (cmd) => cmd.puppet_id,
  initial: () => ({
    puppet: null,
    parts: new Map(), // part_id -> 部件（含 damages、repairs）
    partOrder: [],
    substitutes: [], // 以本偶为老件的替身登记
    playableRoles: new Set(), // "play_id::role"
    handlingLevel: "authentic",
  }),

  fold(state, event) {
    const p = event.payload ?? {};
    switch (event.event_type) {
      case "OBJECT_REGISTERED":
        state.puppet = {
          puppet_id: p.puppet_id,
          name: p.name,
          artifact_class: p.artifact_class,
          dating: p.dating,
          registered_at: event.occurred_at,
        };
        state.handlingLevel = p.artifact_class === "replica" ? "replica" : "authentic";
        break;
      case "PART_REGISTERED":
        state.parts.set(p.part_id, {
          part_id: p.part_id,
          puppet_id: p.puppet_id,
          name: p.name,
          status: p.initial_status ?? "ok",
          damages: [],
          repairs: [],
        });
        state.partOrder.push(p.part_id);
        break;
      case "DAMAGE_OBSERVED": {
        const part = state.parts.get(p.part_id);
        if (part) {
          part.damages.push({
            damage_event_id: event.event_id,
            kind: p.damage_kind,
            severity: p.severity,
            description: p.description,
            observed_by: p.observed_by,
            observed_at: event.occurred_at,
            part_only: p.part_only,
          });
        }
        break;
      }
      case "PART_FROZEN": {
        const part = state.parts.get(p.part_id);
        if (part) {
          part.status = "frozen";
          part.freeze_reason = p.reason;
          part.frozen_at = event.occurred_at;
          part.frozen_by_damage = p.damage_event_id;
        }
        break;
      }
      case "REPAIR_LAYER_ADDED": {
        const part = state.parts.get(p.part_id);
        if (part) {
          part.repairs.push({
            repair_id: p.repair_id,
            layer_no: p.layer_no,
            materials: [...p.materials],
            techniques: [...p.techniques],
            conservator_id: p.conservator_id,
            note: p.note,
            repaired_at: event.occurred_at,
          });
        }
        break;
      }
      case "PART_RETURNED_TO_SERVICE": {
        const part = state.parts.get(p.part_id);
        if (part) {
          part.status = p.resulting_status;
          part.returned_at = event.occurred_at;
          delete part.freeze_reason;
          delete part.frozen_by_damage;
        }
        break;
      }
      case "SUBSTITUTE_REGISTERED":
        state.substitutes.push({
          replica_puppet_id: p.replica_puppet_id,
          antique_puppet_id: p.antique_puppet_id,
          covers_part_ids: [...p.covers_part_ids],
          approvedRoles: new Set(p.approved_roles.map((r) => `${r.play_id}::${r.role}`)),
          approved_roles: p.approved_roles,
          approved_by: p.approved_by,
        });
        break;
      case "PLAYABLE_ROLE_DECLARED":
        state.playableRoles.add(`${p.play_id}::${p.role}`);
        break;
      case "HANDLING_LEVEL_SET":
        state.handlingLevel = p.handling_level;
        break;
      default:
        break;
    }
    return state;
  },

  handlers: {
    RegisterPuppet(state, cmd, ctx) {
      requireRole(ctx, ["company_lead", "conservator"], "登记影偶");
      if (state.puppet) throw new DomainError("ALREADY_EXISTS", `影偶 ${cmd.puppet_id} 已登记`);
      if (!["antique", "replica"].includes(cmd.artifact_class)) {
        throw new DomainError("BAD_INPUT", "artifact_class 必须是 antique 或 replica");
      }
      return {
        eventType: "OBJECT_REGISTERED",
        summary: `${cmd.artifact_class === "antique" ? "老件" : "复制品"}影偶登记：${cmd.name}（${cmd.dating}）`,
        payload: {
          puppet_id: cmd.puppet_id,
          name: cmd.name,
          artifact_class: cmd.artifact_class,
          dating: cmd.dating,
          acquired_at: cmd.acquired_at,
          note: cmd.note,
        },
      };
    },

    RegisterPart(state, cmd, ctx) {
      requireRole(ctx, ["conservator", "company_lead"], "登记部件");
      assertPuppet(state);
      if (state.parts.has(cmd.part_id)) {
        throw new DomainError("ALREADY_EXISTS", `部件 ${cmd.part_id} 已存在`);
      }
      return {
        eventType: "PART_REGISTERED",
        summary: `登记部件：${state.puppet.name}/${cmd.name}`,
        payload: {
          part_id: cmd.part_id,
          puppet_id: cmd.puppet_id,
          name: cmd.name,
          initial_status: cmd.initial_status ?? "ok",
          note: cmd.note,
        },
      };
    },

    ObserveDamage(state, cmd, ctx) {
      requireRole(ctx, ["conservator", "company_lead"], "记录损伤");
      assertPuppet(state);
      const part = state.parts.get(cmd.part_id);
      if (!part) throw new DomainError("NOT_FOUND", `部件不存在：${cmd.part_id}`);
      if (!cmd.description) throw new DomainError("BAD_INPUT", "损伤描述不能为空");

      const damageEventId = `dmg-${cmd.part_id}-${eventTimestamp(ctx.at)}`;
      const targets = cmd.part_only === false ? state.partOrder.slice() : [cmd.part_id];
      const reasonBase = damageLabel(cmd.damage_kind) + (cmd.severity === 3 ? "（重度）" : cmd.severity === 2 ? "（中度）" : "（轻度）");

      const events = [
        {
          eventId: damageEventId,
          eventType: "DAMAGE_OBSERVED",
          summary: `发现${reasonBase}：${state.puppet.name}/${part.name} —— ${cmd.description}`,
          payload: {
            puppet_id: cmd.puppet_id,
            part_id: cmd.part_id,
            damage_kind: cmd.damage_kind,
            severity: cmd.severity,
            description: cmd.description,
            observed_by: ctx.actor.id,
            part_only: cmd.part_only !== false,
            image_refs: cmd.image_refs,
          },
        },
      ];
      for (const partId of targets) {
        const target = state.parts.get(partId);
        if (!target || target.status === "frozen") continue;
        events.push({
          eventType: "PART_FROZEN",
          summary: `冻结部件：${state.puppet.name}/${target.name}（${reasonBase}）`,
          causedBy: [damageEventId],
          payload: {
            puppet_id: cmd.puppet_id,
            part_id: partId,
            reason: `${reasonBase}：${cmd.description}`,
            damage_event_id: damageEventId,
          },
        });
      }
      return events;
    },

    AddRepairLayer(state, cmd, ctx) {
      requireRole(ctx, ["conservator"], "记录传统修复");
      assertPuppet(state);
      const part = state.parts.get(cmd.part_id);
      if (!part) throw new DomainError("NOT_FOUND", `部件不存在：${cmd.part_id}`);
      if (!Array.isArray(cmd.materials) || cmd.materials.length === 0) {
        throw new DomainError("BAD_INPUT", "修复必须记录所用材料");
      }
      if (!Array.isArray(cmd.techniques) || cmd.techniques.length === 0) {
        throw new DomainError("BAD_INPUT", "修复必须记录所用手法");
      }
      const layerNo = part.repairs.length + 1;
      const repairId = cmd.repair_id ?? `rep-${cmd.part_id}-L${layerNo}`;
      return {
        eventType: "REPAIR_LAYER_ADDED",
        summary: `修复第 ${layerNo} 层：${state.puppet.name}/${part.name}，材料 ${cmd.materials.join("、")}`,
        payload: {
          puppet_id: cmd.puppet_id,
          part_id: cmd.part_id,
          repair_id: repairId,
          layer_no: layerNo,
          materials: cmd.materials,
          techniques: cmd.techniques,
          conservator_id: ctx.actor.id,
          note: cmd.note,
        },
      };
    },

    InspectAndReturn(state, cmd, ctx) {
      requireRole(ctx, ["conservator"], "修复后检验");
      assertPuppet(state);
      const part = state.parts.get(cmd.part_id);
      if (!part) throw new DomainError("NOT_FOUND", `部件不存在：${cmd.part_id}`);
      const resulting = cmd.resulting_status ?? "ok";
      if (!["ok", "watch"].includes(resulting)) {
        throw new DomainError("BAD_INPUT", "检验结果只能是 ok 或 watch，不能继续冻结");
      }
      const inspectionId = cmd.inspection_id ?? `insp-${cmd.part_id}-${eventTimestamp(ctx.at)}`;
      return {
        eventId: inspectionId,
        eventType: "PART_RETURNED_TO_SERVICE",
        summary: `检验后${resulting === "ok" ? "恢复使用" : "转为观察"}：${state.puppet.name}/${part.name}`,
        payload: {
          puppet_id: cmd.puppet_id,
          part_id: cmd.part_id,
          inspection_id: inspectionId,
          condition_note: cmd.condition_note,
          resulting_status: resulting,
        },
      };
    },

    DeclareSubstitute(state, cmd, ctx) {
      requireRole(ctx, ["conservator", "company_lead"], "核准复制替身");
      assertPuppet(state);
      if (state.puppet.artifact_class !== "antique") {
        throw new DomainError("BAD_INPUT", "只能为老件登记替身");
      }
      if (cmd.replica_puppet_id === cmd.puppet_id) {
        throw new DomainError("BAD_INPUT", "物件不能作为自身的替身");
      }
      for (const partId of cmd.covers_part_ids ?? []) {
        if (!state.parts.has(partId)) throw new DomainError("NOT_FOUND", `被覆盖部件不存在于老件：${partId}`);
      }
      if (!Array.isArray(cmd.approved_roles) || cmd.approved_roles.length === 0) {
        throw new DomainError("BAD_INPUT", "替身必须至少核准一个剧目角色");
      }
      return {
        eventType: "SUBSTITUTE_REGISTERED",
        summary: `核准复制品 ${cmd.replica_puppet_id} 作为 ${state.puppet.name} 的替身`,
        payload: {
          replica_puppet_id: cmd.replica_puppet_id,
          name: cmd.replica_name,
          antique_puppet_id: cmd.puppet_id,
          covers_part_ids: cmd.covers_part_ids ?? [],
          approved_roles: cmd.approved_roles,
          approved_by: ctx.actor.id,
        },
      };
    },

    DeclarePlayableRole(state, cmd, ctx) {
      requireRole(ctx, ["inheritor", "company_lead"], "声明可演剧目角色");
      assertPuppet(state);
      return {
        eventType: "PLAYABLE_ROLE_DECLARED",
        summary: `${state.puppet.name} 可承担《${cmd.play_id}》${cmd.role}`,
        payload: { puppet_id: cmd.puppet_id, play_id: cmd.play_id, role: cmd.role },
      };
    },

    SetHandlingLevel(state, cmd, ctx) {
      requireRole(ctx, ["company_lead", "conservator"], "设定道具接触级别");
      assertPuppet(state);
      if (!["authentic", "replica"].includes(cmd.handling_level)) {
        throw new DomainError("BAD_INPUT", "接触级别必须是 authentic 或 replica");
      }
      // 老件不可降为 replica；谁能接触老件由学徒聚合的接触授权决定
      if (state.puppet.artifact_class === "antique" && cmd.handling_level === "replica") {
        throw new DomainError(
          "BAD_INPUT",
          "老件不能标记为 replica 级别；限制接触人应通过学徒接触授权（HANDLING_PRIVILEGE_GRANTED）处理",
        );
      }
      return {
        eventType: "HANDLING_LEVEL_SET",
        summary: `${state.puppet.name} 接触级别设为 ${cmd.handling_level}`,
        payload: { puppet_id: cmd.puppet_id, handling_level: cmd.handling_level, reason: cmd.reason ?? "" },
      };
    },
  },
};

function assertPuppet(state) {
  if (!state.puppet) throw new DomainError("NOT_FOUND", "影偶尚未登记");
}

function damageLabel(kind) {
  return (
    {
      crack: "开裂",
      worm: "虫蛀",
      fracture: "断裂",
      surface_wear: "表面磨损",
      loose_joint: "关节松动",
      other: "损伤",
    }[kind] ?? "损伤"
  );
}

function eventTimestamp(at) {
  return String(at).replace(/[-:T.Z+]/g, "").slice(0, 14);
}
