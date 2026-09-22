import { EventStore } from "./store/eventStore.js";
import { puppetAggregate } from "./aggregates/puppetAggregate.js";
import { apprenticeAggregate } from "./aggregates/apprenticeAggregate.js";
import { planAggregate } from "./aggregates/planAggregate.js";
import { environmentAggregate } from "./aggregates/environmentAggregate.js";
import { loanAggregate } from "./aggregates/loanAggregate.js";

/**
 * 读模型：对只追加事件做投影，回答三类角色的问题。
 * 投影每次重建（内存实现）；事件不可变，投影可随时丢弃重建。
 */

function foldAll(store, def) {
  const rows = [];
  for (const key of store.keys()) {
    if (!key.startsWith(`${def.aggregateType}:`)) continue;
    const events = store.load(key);
    let state = def.initial();
    for (const event of events) state = def.fold(state, event);
    if (events.length > 0) rows.push({ id: key.slice(def.aggregateType.length + 1), state, events });
  }
  return rows;
}

/**
 * 修缮师视角：从损伤追到最近使用与环境。
 * 返回每件影偶每个部件的当前状态、损伤时间线、修复层，
 * 以及每次损伤之前最近一次授权上台（时间/场地/操作者）与此前 48 小时相关环境读数。
 */
export function buildConservationTrace(store, options = {}) {
  const envWindowMs = (options.env_window_hours ?? 48) * 3600_000;
  const plans = foldAll(store, planAggregate);
  const envRows = foldAll(store, environmentAggregate);

  // 授权上台记录：按影偶汇总（含替身条目同时记录老件）
  const usesByPuppet = new Map();
  for (const { state } of plans) {
    if (!state.plan) continue;
    for (const item of state.items.values()) {
      if (!item.authorization) continue;
      const effectiveId = item.substitute ? item.substitute.replica_puppet_id : item.puppet_id;
      const record = {
        plan_id: state.plan.plan_id,
        title: state.plan.title,
        venue: state.plan.venue,
        starts_at: state.plan.starts_at,
        play_id: item.play_id,
        role: item.role,
        operator_id: item.operator_id,
        authorized_by: item.authorization.granted_by,
        via_substitute: item.substitute ? item.substitute.antique_puppet_id : null,
      };
      push(usesByPuppet, effectiveId, record);
      if (item.substitute) push(usesByPuppet, item.substitute.antique_puppet_id, { ...record, used_replica: item.substitute.replica_puppet_id });
    }
  }
  for (const list of usesByPuppet.values()) list.sort((a, b) => b.starts_at.localeCompare(a.starts_at));

  return foldAll(store, puppetAggregate).map(({ id, state }) => {
    const parts = state.partOrder.map((partId) => {
      const part = state.parts.get(partId);
      const damages = part.damages.map((d) => {
        const before = new Date(d.observed_at).getTime();
        const priorUses = (usesByPuppet.get(id) ?? []).filter((u) => new Date(u.starts_at).getTime() <= before);
        const envSignals = [];
        for (const { id: location, state: env } of envRows) {
          for (const reading of env.readings) {
            const t = new Date(reading.at).getTime();
            if (
              reading.puppet_ids_present.includes(id) &&
              t <= before &&
              before - t <= envWindowMs
            ) {
              envSignals.push({ location, ...reading });
            }
          }
        }
        envSignals.sort((a, b) => b.at.localeCompare(a.at));
        return {
          damage_event_id: d.damage_event_id,
          kind: d.kind,
          severity: d.severity,
          description: d.description,
          observed_by: d.observed_by,
          observed_at: d.observed_at,
          nearest_prior_use: priorUses[0] ?? null,
          environment_before: envSignals.slice(0, 5),
        };
      });
      return {
        part_id: part.part_id,
        name: part.name,
        status: part.status,
        ...(part.freeze_reason ? { freeze_reason: part.freeze_reason, frozen_at: part.frozen_at } : {}),
        damages,
        repair_layers: part.repairs.map((r) => ({
          repair_id: r.repair_id,
          layer_no: r.layer_no,
          materials: r.materials,
          techniques: r.techniques,
          conservator_id: r.conservator_id,
          repaired_at: r.repaired_at,
          note: r.note,
        })),
      };
    });
    return {
      puppet_id: id,
      name: state.puppet?.name ?? null,
      artifact_class: state.puppet?.artifact_class ?? null,
      dating: state.puppet?.dating ?? null,
      handling_level: state.handlingLevel,
      parts,
      substitutes: state.substitutes.map((s) => ({
        replica_puppet_id: s.replica_puppet_id,
        covers_part_ids: s.covers_part_ids,
        approved_roles: s.approved_roles,
        approved_by: s.approved_by,
      })),
    };
  });
}

/**
 * 传承人视角：学徒真实能力名册。
 * independent 必须有师傅复核；同时标出未成年人与接触级别。
 */
export function buildCompetencyRoster(store) {
  return foldAll(store, apprenticeAggregate).map(({ id, state }) => {
    const competency = (key, label) => {
      const c = state.competencies.get(key);
      return {
        competency: key,
        label,
        stage: c?.stage ?? "none",
        layer: c?.layer ?? 0,
        independent: c?.stage === "independent" && Boolean(c?.review),
        master_review: c?.review
          ? { reviewer_id: c.review.reviewer_id, at: c.review.at, note: c.review.note }
          : null,
      };
    };
    return {
      apprentice_id: id,
      name: state.apprentice?.name ?? null,
      minor: state.apprentice?.minor ?? false,
      handling_level: state.handling_level,
      may_touch_antique: state.handling_level === "authentic" && !(state.apprentice?.minor ?? false),
      competencies: [
        competency("manipulation", "独立操控"),
        competency("crafting", "独立制作"),
        competency("repair", "独立修补"),
      ],
    };
  });
}

/**
 * 演出经理视角：换场看板。
 * 逐条目给状态、最近评估理由、替身建议/已指派、授权情况，
 * 让经理在不伤害老件的前提下完成换场。
 */
export function buildStageBoard(store) {
  return foldAll(store, planAggregate).map(({ state }) => {
    const items = state.itemOrder.map((itemId) => {
      const item = state.items.get(itemId);
      const liveEvaluations = item.evaluations.filter((e) => !e.invalidated);
      const latest = liveEvaluations[liveEvaluations.length - 1] ?? null;
      return {
        item_id: item.item_id,
        play_id: item.play_id,
        role: item.role,
        antique_puppet_id: item.puppet_id,
        effective_puppet_id: item.substitute ? item.substitute.replica_puppet_id : item.puppet_id,
        part_ids: item.part_ids,
        operator_id: item.operator_id,
        operator_supervised: item.operator_supervised,
        status: item.status,
        latest_decision: latest?.decision ?? null,
        latest_reasons: latest?.reasons ?? [],
        block_reasons: latest?.decision === "blocked" ? latest.reasons : [],
        suggested_replica_puppet_id: latest?.suggested_replica_puppet_id ?? null,
        assigned_substitute: item.substitute
          ? { replica_puppet_id: item.substitute.replica_puppet_id, assigned_by: item.substitute.assigned_by }
          : null,
        authorized: Boolean(item.authorization),
        authorization: item.authorization,
        stale_note: item.evaluations.find((e) => e.invalidated)?.why ?? null,
      };
    });
    return {
      plan_id: state.plan?.plan_id ?? null,
      title: state.plan?.title ?? null,
      venue: state.plan?.venue ?? null,
      starts_at: state.plan?.starts_at ?? null,
      tickets_sold: state.plan?.tickets_sold ?? false,
      cancelled: state.cancelled,
      items,
      /** 经理下一步动作建议（确定性，便于自动派单）。 */
      next_actions: items
        .map((item) => ({ item_id: item.item_id, action: suggestAction(item) }))
        .filter((x) => x.action),
    };
  });
}

/** 物件当前在哪：综合借用流，给每件影偶一个唯一当前位置。 */
export function buildCustodyMap(store) {
  const byPuppet = new Map();
  for (const { state } of foldAll(store, loanAggregate)) {
    if (!state.loan || !state.puppet_id) continue;
    const record = {
      puppet_id: state.puppet_id,
      loan_id: state.loan.loan_id,
      status: state.status,
      current_custodian_id: state.current_custodian_id,
      chain: state.chain,
      conflict: state.conflict ?? null,
    };
    if (!byPuppet.has(state.puppet_id)) byPuppet.set(state.puppet_id, []);
    byPuppet.get(state.puppet_id).push(record);
  }

  const result = [];
  for (const [puppetId, records] of byPuppet) {
    const open = records.filter((r) => ["checked_out", "in_transfer", "missing"].includes(r.status));
    if (open.length === 1) {
      result.push(open[0]);
    } else if (open.length > 1) {
      // 两个未结清位置——正常路径不应出现；出现即标冲突待人工核查
      result.push({
        puppet_id: puppetId,
        status: "conflict",
        current_custodian_id: null,
        conflicting_loans: open.map((r) => r.loan_id),
        conflicting_custodians: open.map((r) => r.current_custodian_id),
      });
    } else {
      // 全部已结清，取最近一条归还记录
      result.push(records[records.length - 1]);
    }
  }
  return result;
}

function suggestAction(item) {
  if (item.status === "cancelled") return null;
  if (item.latest_decision === "cleared" && !item.authorized) return "等待负责人/传承人显式授权";
  if (item.latest_decision !== "blocked") return null;
  if (item.assigned_substitute) return "替身已指派，需重新评估";
  if (item.suggested_replica_puppet_id) {
    return `指派经核准替身 ${item.suggested_replica_puppet_id} 后重新评估`;
  }
  return "无可核准替身：更换剧目或停用该老件";
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}
