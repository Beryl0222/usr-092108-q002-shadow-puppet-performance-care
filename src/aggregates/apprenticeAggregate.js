import { DomainError } from "../errors.js";
import { requireRole } from "./runner.js";

/**
 * 学徒资格聚合（aggregate_type=apprentice_clearance）
 *
 * 资格推进规则：
 *  - 分层训练 layer 只能 +1 递进，不能跳层；阶段只能 none→trainee→supervised→independent。
 *  - 训练记录不授予独立资格；必须有师傅（inheritor）复核 MASTER_REVIEW_PASSED，
 *    才把该能力域标记为“可独立”，独立即真实能力凭证。
 *  - 接触级别 authentic 只能由传承人授予；未成年人一律不得获得 authentic，
 *    只能接触 replica 级别道具。
 */
const STAGE_RANK = { none: 0, trainee: 1, supervised: 2, independent: 3 };

export const apprenticeAggregate = {
  aggregateType: "apprentice_clearance",
  aggregateId: (cmd) => cmd.apprentice_id,
  initial: () => ({
    apprentice: null,
    // competency -> { stage, layer, review: {by, at, note} }
    competencies: new Map(),
    handling_level: null,
    handling_grants: [],
  }),

  fold(state, event) {
    const p = event.payload ?? {};
    switch (event.event_type) {
      case "APPRENTICE_ENROLLED":
        state.apprentice = {
          apprentice_id: p.apprentice_id,
          name: p.name,
          minor: p.minor,
          enrolled_by: p.enrolled_by,
          enrolled_at: event.occurred_at,
        };
        break;
      case "TRAINING_LEVEL_RECORDED": {
        const current = state.competencies.get(p.competency) ?? { stage: "none", layer: 0, review: null };
        current.stage = p.stage;
        current.layer = p.layer;
        current.last_note = p.note;
        state.competencies.set(p.competency, current);
        break;
      }
      case "MASTER_REVIEW_PASSED": {
        const current = state.competencies.get(p.competency);
        if (current) {
          current.stage = "independent";
          current.review = { reviewer_id: p.reviewer_id, at: event.occurred_at, note: p.note };
        }
        break;
      }
      case "HANDLING_PRIVILEGE_GRANTED":
        state.handling_level = p.handling_level;
        state.handling_grants.push({
          handling_level: p.handling_level,
          granted_by: p.granted_by,
          note: p.note,
          at: event.occurred_at,
        });
        break;
      default:
        break;
    }
    return state;
  },

  handlers: {
    EnrollApprentice(state, cmd, ctx) {
      requireRole(ctx, ["inheritor", "company_lead"], "登记学徒");
      if (state.apprentice) throw new DomainError("ALREADY_EXISTS", `学徒 ${cmd.apprentice_id} 已登记`);
      return {
        eventType: "APPRENTICE_ENROLLED",
        summary: `登记学徒：${cmd.name}${cmd.minor ? "（未成年人）" : ""}`,
        payload: {
          apprentice_id: cmd.apprentice_id,
          name: cmd.name,
          minor: cmd.minor === true,
          enrolled_by: ctx.actor.id,
        },
      };
    },

    RecordTrainingLevel(state, cmd, ctx) {
      requireRole(ctx, ["inheritor"], "记录分层训练");
      assertEnrolled(state);
      const current = state.competencies.get(cmd.competency) ?? { stage: "none", layer: 0 };
      if (!Number.isInteger(cmd.layer) || cmd.layer < 1) {
        throw new DomainError("BAD_INPUT", "训练层级 layer 必须是 >=1 的整数");
      }
      if (cmd.layer > current.layer + 1) {
        throw new DomainError(
          "LAYER_SKIPPED",
          `训练不能跳层：${cmd.competency} 当前第 ${current.layer} 层，不能直接记第 ${cmd.layer} 层`,
        );
      }
      if (STAGE_RANK[cmd.stage] === undefined) {
        throw new DomainError("BAD_INPUT", "阶段必须是 none/trainee/supervised/independent");
      }
      if (cmd.stage === "independent") {
        throw new DomainError(
          "REVIEW_REQUIRED",
          "训练记录不能直接授予独立资格，须先记录 supervised 再由师傅复核",
        );
      }
      if (STAGE_RANK[cmd.stage] < STAGE_RANK[current.stage]) {
        throw new DomainError("STAGE_REGRESSION", "训练阶段不能倒退；更正请产生新的复核记录");
      }
      return {
        eventType: "TRAINING_LEVEL_RECORDED",
        summary: `${state.apprentice.name} 的${competencyLabel(cmd.competency)}训练推进至第 ${cmd.layer} 层（${stageLabel(cmd.stage)}）`,
        payload: {
          apprentice_id: cmd.apprentice_id,
          competency: cmd.competency,
          stage: cmd.stage,
          layer: cmd.layer,
          note: cmd.note,
          recorded_by: ctx.actor.id,
        },
      };
    },

    PassMasterReview(state, cmd, ctx) {
      requireRole(ctx, ["inheritor"], "师傅复核");
      assertEnrolled(state);
      const current = state.competencies.get(cmd.competency);
      if (!current || current.stage !== "supervised") {
        throw new DomainError(
          "NOT_READY",
          `${state.apprentice.name} 的${competencyLabel(cmd.competency)}尚未进入监督实操阶段，不能复核独立`,
        );
      }
      if (current.review) {
        throw new DomainError("ALREADY_REVIEWED", "该能力域已通过师傅独立复核");
      }
      return {
        eventType: "MASTER_REVIEW_PASSED",
        summary: `${state.apprentice.name} 通过${competencyLabel(cmd.competency)}独立复核，具备独立能力`,
        payload: {
          apprentice_id: cmd.apprentice_id,
          competency: cmd.competency,
          reviewer_id: ctx.actor.id,
          note: cmd.note,
        },
      };
    },

    GrantHandlingPrivilege(state, cmd, ctx) {
      requireRole(ctx, ["inheritor"], "授予道具接触级别");
      assertEnrolled(state);
      if (cmd.handling_level === "authentic" && state.apprentice.minor) {
        throw new DomainError(
          "MINOR_FORBIDDEN",
          `学徒 ${state.apprentice.name} 为未成年人，只能接触 replica 级别道具，不得授权老件`,
        );
      }
      if (state.handling_level === "authentic") {
        throw new DomainError("ALREADY_GRANTED", "已获得 authentic 级别；撤回须产生新的显式事件");
      }
      return {
        eventType: "HANDLING_PRIVILEGE_GRANTED",
        summary: `${state.apprentice.name} 获授${cmd.handling_level === "authentic" ? "老件接触" : "复制品接触"}级别`,
        payload: {
          apprentice_id: cmd.apprentice_id,
          handling_level: cmd.handling_level,
          granted_by: ctx.actor.id,
          note: cmd.note,
        },
      };
    },
  },
};

function assertEnrolled(state) {
  if (!state.apprentice) throw new DomainError("NOT_FOUND", "学徒尚未登记");
}

export function competencyLabel(c) {
  return { manipulation: "操控", crafting: "制作", repair: "修补" }[c] ?? c;
}

export function stageLabel(s) {
  return { none: "未入门", trainee: "在训", supervised: "监督下实操", independent: "可独立" }[s] ?? s;
}
