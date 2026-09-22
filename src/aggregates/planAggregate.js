import { DomainError } from "../errors.js";
import { requireRole } from "./runner.js";

/**
 * 演出/排练计划聚合（aggregate_type=performance_plan）
 *
 * 上台放行三重门（针对老件）：
 *   1. 保存状态：所需部件无冻结、影偶可承担该剧目角色、未报失踪；
 *   2. 环境：开场前有效窗口内有读数，且湿度/温度在阈值内；
 *   3. 授权：评估通过后仍须负责人/传承人显式授权——已售票不自动放行。
 * 任一不满足 → blocked；发现冻结部件时给出经核准替身的建议，
 * 但替身必须显式指派（SUBSTITUTE_ASSIGNED），指派后按替身重新评估。
 *
 * 换戏/换偶/换操作者都会使既有评估与授权失效，必须重走流程。
 */

const HUMIDITY_MAX_PCT = 70; // 高湿阈值
const TEMP_MIN_C = 5;
const TEMP_MAX_C = 32;
const ENV_WINDOW_HOURS = 6;

export const planAggregate = {
  aggregateType: "performance_plan",
  aggregateId: (cmd) => cmd.plan_id,
  initial: () => ({
    plan: null,
    items: new Map(),
    itemOrder: [],
    cancelled: false,
  }),

  fold(state, event) {
    const p = event.payload ?? {};
    switch (event.event_type) {
      case "PERFORMANCE_PLANNED":
        state.plan = {
          plan_id: p.plan_id,
          occasion: p.occasion,
          title: p.title,
          venue: p.venue,
          starts_at: p.starts_at,
          tickets_sold: p.tickets_sold,
          planned_by: p.planned_by,
        };
        for (const item of p.items) {
          state.items.set(item.item_id, {
            item_id: item.item_id,
            play_id: item.play_id,
            role: item.role,
            puppet_id: item.puppet_id,
            part_ids: item.part_ids ?? [],
            operator_id: item.operator_id ?? null,
            operator_supervised: item.operator_supervised ?? false,
            status: "scheduled",
            evaluations: [],
            authorization: null,
            substitute: null,
          });
          state.itemOrder.push(item.item_id);
        }
        break;
      case "PLAY_SWAPPED": {
        const item = state.items.get(p.item_id);
        if (item) {
          item.play_id = p.to_play_id;
          item.role = p.to_role;
          invalidateClearance(item, "临时换戏");
        }
        break;
      }
      case "CASTING_CHANGED": {
        const item = state.items.get(p.item_id);
        if (item) {
          item.puppet_id = p.puppet_id;
          item.part_ids = p.part_ids ?? [];
          invalidateClearance(item, "更换影偶");
        }
        break;
      }
      case "OPERATOR_ASSIGNED": {
        const item = state.items.get(p.item_id);
        if (item) {
          item.operator_id = p.operator_id;
          item.operator_supervised = p.operator_supervised ?? false;
          invalidateClearance(item, "更换操作者");
        }
        break;
      }
      case "CLEARANCE_EVALUATED": {
        const item = state.items.get(p.item_id);
        if (item) {
          item.evaluations.push({
            event_id: event.event_id,
            at: event.occurred_at,
            puppet_id: p.puppet_id,
            decision: p.decision,
            reasons: p.reasons,
            suggested_replica_puppet_id: p.suggested_replica_puppet_id,
            evaluated_by: p.evaluated_by,
          });
          if (p.decision === "blocked") {
            item.status = "blocked";
            item.authorization = null;
          } else {
            // 通过仅表示具备上台条件；授权未下前仍处于待授权的已排期状态
            item.status = "scheduled";
          }
        }
        break;
      }
      case "STAGE_USE_BLOCKED":
        // 与 CLEARANCE_EVALUATED(blocked) 配对的留痕事件，状态已在上一条处理
        break;
      case "STAGE_AUTHORIZATION_GRANTED": {
        const item = state.items.get(p.item_id);
        if (item) {
          item.authorization = { granted_by: p.granted_by, at: event.occurred_at, scope: p.scope };
          item.status = item.substitute ? "substituted" : "cleared";
        }
        break;
      }
      case "SUBSTITUTE_ASSIGNED": {
        const item = state.items.get(p.item_id);
        if (item) {
          item.substitute = {
            replica_puppet_id: p.replica_puppet_id,
            antique_puppet_id: p.antique_puppet_id,
            approved_for: p.approved_for,
            assigned_by: p.assigned_by,
            at: event.occurred_at,
          };
          invalidateClearance(item, "指派替身");
          item.status = "scheduled";
        }
        break;
      }
      case "PLAN_CANCELLED":
        state.cancelled = true;
        state.cancel_reason = p.reason;
        for (const item of state.items.values()) item.status = "cancelled";
        break;
      default:
        break;
    }
    return state;
  },

  handlers: {
    PlanPerformance(state, cmd, ctx) {
      requireRole(ctx, ["performance_manager", "company_lead"], "排定演出/排练");
      if (state.plan) throw new DomainError("ALREADY_EXISTS", `计划 ${cmd.plan_id} 已存在`);
      if (!Array.isArray(cmd.items) || cmd.items.length === 0) {
        throw new DomainError("BAD_INPUT", "计划至少包含一个剧目条目");
      }
      const seen = new Set();
      for (const item of cmd.items) {
        if (seen.has(item.item_id)) throw new DomainError("BAD_INPUT", `条目编号重复：${item.item_id}`);
        seen.add(item.item_id);
      }
      return {
        eventType: "PERFORMANCE_PLANNED",
        summary: `排定${occasionLabel(cmd.occasion)}《${cmd.title}》于 ${cmd.venue}，${cmd.items.length} 个条目${cmd.tickets_sold ? "（已售票）" : ""}`,
        payload: {
          plan_id: cmd.plan_id,
          occasion: cmd.occasion,
          title: cmd.title,
          venue: cmd.venue,
          starts_at: cmd.starts_at,
          tickets_sold: cmd.tickets_sold === true,
          items: cmd.items.map((item) => ({
            item_id: item.item_id,
            play_id: item.play_id,
            role: item.role,
            puppet_id: item.puppet_id,
            part_ids: item.part_ids ?? [],
            operator_id: item.operator_id,
            operator_supervised: item.operator_supervised ?? false,
          })),
          planned_by: ctx.actor.id,
        },
      };
    },

    SwapPlay(state, cmd, ctx) {
      requireRole(ctx, ["performance_manager", "company_lead"], "临时换戏");
      assertActive(state);
      const item = assertItem(state, cmd.item_id);
      if (item.play_id === cmd.to_play_id && item.role === cmd.to_role) {
        throw new DomainError("NO_CHANGE", "新剧目角色与现状一致");
      }
      return {
        eventType: "PLAY_SWAPPED",
        summary: `《${state.plan.title}》条目 ${cmd.item_id} 临时换戏：${item.play_id}/${item.role} → ${cmd.to_play_id}/${cmd.to_role}`,
        payload: {
          plan_id: cmd.plan_id,
          item_id: cmd.item_id,
          from_play_id: item.play_id,
          to_play_id: cmd.to_play_id,
          to_role: cmd.to_role,
          swapped_by: ctx.actor.id,
          reason: cmd.reason,
        },
      };
    },

    ChangeCasting(state, cmd, ctx) {
      requireRole(ctx, ["performance_manager", "company_lead"], "更换影偶");
      assertActive(state);
      const item = assertItem(state, cmd.item_id);
      return {
        eventType: "CASTING_CHANGED",
        summary: `条目 ${cmd.item_id} 改用影偶 ${cmd.puppet_id}`,
        payload: {
          plan_id: cmd.plan_id,
          item_id: cmd.item_id,
          puppet_id: cmd.puppet_id,
          part_ids: cmd.part_ids ?? [],
          changed_by: ctx.actor.id,
          reason: cmd.reason,
        },
      };
    },

    AssignOperator(state, cmd, ctx) {
      requireRole(ctx, ["performance_manager", "inheritor"], "指派操作者");
      assertActive(state);
      assertItem(state, cmd.item_id);
      return {
        eventType: "OPERATOR_ASSIGNED",
        summary: `条目 ${cmd.item_id} 操作者指派为 ${cmd.operator_id}${cmd.operator_supervised ? "（师傅在场监督）" : ""}`,
        payload: {
          plan_id: cmd.plan_id,
          item_id: cmd.item_id,
          operator_id: cmd.operator_id,
          operator_supervised: cmd.operator_supervised === true,
        },
      };
    },

    EvaluateClearance(state, cmd, ctx) {
      requireRole(ctx, ["performance_manager", "conservator", "company_lead"], "上台评估");
      assertActive(state);
      const item = assertItem(state, cmd.item_id);
      const registry = ctx.registry;
      if (!registry) throw new DomainError("NO_REGISTRY", "放行评估需要跨聚合查询注册中心");

      const reasons = [];
      const usingSubstitute = Boolean(item.substitute);
      const effectivePuppetId = usingSubstitute ? item.substitute.replica_puppet_id : item.puppet_id;
      const puppetView = registry.puppet(effectivePuppetId);

      if (!puppetView?.puppet) {
        reasons.push(`影偶未登记：${effectivePuppetId}`);
      } else {
        const isAntique = puppetView.puppet.artifact_class === "antique";

        // 1) 保存状态：部件冻结
        const requiredParts = item.part_ids ?? [];
        const frozen = requiredParts.filter((pid) => puppetView.parts.get(pid)?.status === "frozen");
        if (requiredParts.length === 0 && isAntique) {
          // 未声明部件时，老件任一冻结部件都视为整偶不可上台
          for (const part of puppetView.parts.values()) {
            if (part.status === "frozen") frozen.push(part.part_id);
          }
        }
        if (frozen.length > 0) {
          reasons.push(`部件处于冻结：${frozen.join("、")}`);
        }

        // 2) 剧目角色适用性
        if (!usingSubstitute && isAntique && !puppetView.playableRoles.has(`${item.play_id}::${item.role}`)) {
          reasons.push(`老件 ${puppetView.puppet.name} 未登记可承担《${item.play_id}》${item.role}`);
        }

        // 3) 借用/失踪状态
        const loan = registry.loanByPuppet(effectivePuppetId);
        if (loan?.status === "missing") reasons.push("该影偶在借用记录中被标记为失踪");

        // 4) 环境窗口（老件硬门槛；替身仅作温和提示，不阻断）
        if (isAntique) {
          const reading = latestReadingInWindow(registry, state.plan.venue, state.plan.starts_at, cmd.env_window_hours);
          if (!reading) {
            reasons.push(`开场前 ${ENV_WINDOW_HOURS} 小时内缺少 ${state.plan.venue} 的有效环境读数`);
          } else if (reading.humidity_pct > HUMIDITY_MAX_PCT) {
            reasons.push(`环境高湿：${reading.humidity_pct}%RH > ${HUMIDITY_MAX_PCT}%RH（读数于 ${reading.at}）`);
          } else if (reading.temp_c < TEMP_MIN_C || reading.temp_c > TEMP_MAX_C) {
            reasons.push(`温度越界：${reading.temp_c}℃ 超出 ${TEMP_MIN_C}–${TEMP_MAX_C}℃（读数于 ${reading.at}）`);
          }
        }

        // 5) 操作者资格（有学徒档案才受学徒规则约束）
        if (item.operator_id) {
          const apprentice = registry.apprentice(item.operator_id);
          if (apprentice?.apprentice) {
            const comp = apprentice.competencies.get("manipulation");
            const independent = comp?.stage === "independent" && comp?.review;
            const supervisedOk = comp?.stage === "supervised" && item.operator_supervised;
            if (!independent && !supervisedOk) {
              reasons.push(
                `操作者 ${apprentice.apprentice.name} 操控资格不足（需可独立，或监督下实操且师傅在场）`,
              );
            }
            if (isAntique && apprentice.handling_level !== "authentic") {
              reasons.push(
                `操作者 ${apprentice.apprentice.name} 未获老件接触授权${apprentice.apprentice.minor ? "（未成年人仅限复制品道具）" : ""}`,
              );
            }
          }
        }
      }

      // 冻结时寻找经过核准的替身建议
      let suggestedReplica;
      if (reasons.some((r) => r.startsWith("部件处于冻结")) && !usingSubstitute) {
        const candidates = registry.findSubstitutes(item.puppet_id, item.play_id, item.role, item.part_ids ?? []);
        suggestedReplica = candidates[0]?.replica_puppet_id;
        if (suggestedReplica) {
          reasons.push(`建议改用经核准复制品替身：${suggestedReplica}（需显式指派后方可生效）`);
        } else {
          reasons.push("没有覆盖该剧目角色且状态可用的已核准替身");
        }
      }

      // 已售票只是风险提示，绝不改变决策
      if (state.plan.tickets_sold) reasons.push("提示：该场已售票，售票不构成放行理由");

      const decision = reasons.filter((r) => !r.startsWith("提示：")).length === 0 ? "cleared" : "blocked";
      const events = [
        {
          eventType: "CLEARANCE_EVALUATED",
          summary:
            decision === "cleared"
              ? `条目 ${cmd.item_id}（${effectivePuppetId}）评估通过，待显式授权`
              : `条目 ${cmd.item_id}（${effectivePuppetId}）评估否决：${reasons.filter((r) => !r.startsWith("提示：")).join("；")}`,
          payload: {
            plan_id: cmd.plan_id,
            item_id: cmd.item_id,
            puppet_id: effectivePuppetId,
            decision,
            reasons,
            ...(suggestedReplica ? { suggested_replica_puppet_id: suggestedReplica } : {}),
            evaluated_by: ctx.actor.id,
          },
        },
      ];
      if (decision === "blocked") {
        events.push({
          eventType: "STAGE_USE_BLOCKED",
          summary: `条目 ${cmd.item_id} 暂缓上台，待处理阻断项`,
          payload: {
            plan_id: cmd.plan_id,
            item_id: cmd.item_id,
            puppet_id: effectivePuppetId,
            reasons: reasons.filter((r) => !r.startsWith("提示：")),
          },
        });
      }
      return events;
    },

    AuthorizeStageUse(state, cmd, ctx) {
      requireRole(ctx, ["company_lead", "inheritor"], "上台授权");
      assertActive(state);
      const item = assertItem(state, cmd.item_id);
      const validEvaluations = item.evaluations.filter((e) => !e.invalidated);
      const latest = validEvaluations[validEvaluations.length - 1];
      if (!latest) throw new DomainError("NOT_EVALUATED", "须先完成上台评估（评估已因变更失效，须重新评估）");
      if (latest.decision !== "cleared") {
        throw new DomainError("BLOCKED", `最近评估为否决：${latest.reasons.join("；")}`);
      }
      if (item.authorization) throw new DomainError("ALREADY_AUTHORIZED", "该条目已授权");
      const effectiveId = item.substitute ? item.substitute.replica_puppet_id : item.puppet_id;
      if (latest.puppet_id !== effectiveId) {
        throw new DomainError("STALE_EVALUATION", "评估后影偶/替身已变更，须重新评估");
      }
      return {
        eventType: "STAGE_AUTHORIZATION_GRANTED",
        summary: `条目 ${cmd.item_id}（${effectiveId}）获显式上台授权：${cmd.scope ?? "本场"}`,
        payload: {
          plan_id: cmd.plan_id,
          item_id: cmd.item_id,
          puppet_id: effectiveId,
          granted_by: ctx.actor.id,
          scope: cmd.scope ?? `《${state.plan.title}》本场`,
        },
      };
    },

    AssignSubstitute(state, cmd, ctx) {
      requireRole(ctx, ["performance_manager", "company_lead", "conservator"], "指派核准替身");
      assertActive(state);
      const item = assertItem(state, cmd.item_id);
      const registry = ctx.registry;
      if (!registry) throw new DomainError("NO_REGISTRY", "指派替身需要跨聚合查询注册中心");
      const antiqueView = registry.puppet(item.puppet_id);
      if (!antiqueView?.puppet || antiqueView.puppet.artifact_class !== "antique") {
        throw new DomainError("BAD_INPUT", "只有老件条目可指派替身");
      }
      const sub = antiqueView.substitutes.find((s) => s.replica_puppet_id === cmd.replica_puppet_id);
      if (!sub) throw new DomainError("NOT_APPROVED", `复制品 ${cmd.replica_puppet_id} 未核准为该老件替身`);
      if (!sub.approvedRoles.has(`${item.play_id}::${item.role}`)) {
        throw new DomainError("NOT_APPROVED", `该替身未核准《${item.play_id}》${item.role}`);
      }
      const requiredParts = item.part_ids ?? [];
      if (requiredParts.length === 0 && sub.covers_part_ids.length > 0) {
        throw new DomainError("NOT_APPROVED", "部件替身不能顶替整偶条目，需要整偶替身");
      }
      if (
        requiredParts.length > 0 &&
        sub.covers_part_ids.length > 0 &&
        !requiredParts.every((pid) => sub.covers_part_ids.includes(pid))
      ) {
        throw new DomainError("NOT_APPROVED", "该替身不覆盖条目所需的全部冻结部件");
      }
      const replicaView = registry.puppet(cmd.replica_puppet_id);
      const required = requiredParts.length > 0 ? requiredParts : [...replicaView.parts.keys()];
      const replicaFrozen = required.filter((pid) => replicaView.parts.get(pid)?.status === "frozen");
      if (replicaFrozen.length > 0) {
        throw new DomainError("REPLICA_UNFIT", `替身自身部件冻结：${replicaFrozen.join("、")}`);
      }
      return {
        eventType: "SUBSTITUTE_ASSIGNED",
        summary: `条目 ${cmd.item_id} 指派替身 ${cmd.replica_puppet_id} 顶替老件 ${item.puppet_id}`,
        payload: {
          plan_id: cmd.plan_id,
          item_id: cmd.item_id,
          antique_puppet_id: item.puppet_id,
          replica_puppet_id: cmd.replica_puppet_id,
          approved_for: { play_id: item.play_id, role: item.role },
          assigned_by: ctx.actor.id,
        },
      };
    },

    CancelPlan(state, cmd, ctx) {
      requireRole(ctx, ["company_lead", "performance_manager"], "取消计划");
      assertActive(state);
      return {
        eventType: "PLAN_CANCELLED",
        summary: `取消《${state.plan.title}》：${cmd.reason}`,
        payload: { plan_id: cmd.plan_id, reason: cmd.reason, cancelled_by: ctx.actor.id },
      };
    },
  },
};

function invalidateClearance(item, why) {
  // 换戏/换偶/换人/指派替身均使既有评估与授权失效
  for (const evaluation of item.evaluations) evaluation.invalidated = true;
  item.evaluations.push({ invalidated: true, why });
  item.authorization = null;
  if (item.status === "cleared" || item.status === "blocked" || item.status === "substituted") {
    item.status = "scheduled";
  }
}

function latestReadingInWindow(registry, venue, startsAt, windowHours = ENV_WINDOW_HOURS) {
  const end = new Date(startsAt);
  const start = new Date(end.getTime() - windowHours * 3600_000);
  const env = registry.environment(venue);
  if (!env) return null;
  const inWindow = env.readings
    .filter((r) => {
      const t = new Date(r.at);
      return t >= start && t <= end;
    })
    .sort((a, b) => a.at.localeCompare(b.at));
  return inWindow[inWindow.length - 1] ?? null;
}

function assertActive(state) {
  if (!state.plan) throw new DomainError("NOT_FOUND", "计划不存在");
  if (state.cancelled) throw new DomainError("PLAN_CANCELLED", "计划已取消");
}

function assertItem(state, itemId) {
  const item = state.items.get(itemId);
  if (!item) throw new DomainError("NOT_FOUND", `剧目条目不存在：${itemId}`);
  return item;
}

function occasionLabel(kind) {
  return { festival: "乡村节庆演出", village: "村镇演出", training: "传习所实操课", rehearsal: "排练", other: "活动" }[kind] ?? "活动";
}
