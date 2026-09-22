import { DomainError } from "../errors.js";
import { requireRole } from "./runner.js";

/**
 * 借用/交接聚合（aggregate_type=loan_record）
 *
 * 不变量：
 *  - 一个影偶同一时刻只能存在一条未结清借用（当前位置唯一）；
 *    在线路径由命令处理器经注册中心拦截，离线路径由同步引擎兜底。
 *  - 交接链只追加；from_custodian 必须等于当前持有人，
 *    防止两批离线记录各自声称把物件交给不同的人（两个当前位置）。
 *  - 归还必须逐部件清点；缺一即标记 missing，不能当作正常归还销账。
 */
export const loanAggregate = {
  aggregateType: "loan_record",
  aggregateId: (cmd) => cmd.loan_id,
  initial: () => ({
    loan: null,
    puppet_id: null,
    status: null, // checked_out | in_transfer | returned | missing
    current_custodian_id: null,
    chain: [],
    returnRecord: null,
  }),

  fold(state, event) {
    const p = event.payload ?? {};
    switch (event.event_type) {
      case "LOAN_CHECKED_OUT":
        state.loan = { loan_id: p.loan_id, purpose: p.purpose, expected_return_at: p.expected_return_at };
        state.puppet_id = p.puppet_id;
        state.status = "checked_out";
        state.current_custodian_id = p.custodian_id;
        state.chain.push({ custodian_id: p.custodian_id, since: event.occurred_at, note: "出库" });
        break;
      case "CUSTODY_TRANSFERRED":
        state.current_custodian_id = p.to_custodian_id;
        state.status = "in_transfer";
        state.chain.push({
          custodian_id: p.to_custodian_id,
          since: event.occurred_at,
          from: p.from_custodian_id,
          note: p.handoff_note,
        });
        break;
      case "LOAN_RETURNED":
        state.status = "returned";
        state.returnRecord = {
          returned_by: p.returned_by,
          condition_note: p.condition_note,
          parts_checked: p.parts_checked,
          at: event.occurred_at,
        };
        break;
      case "ITEM_MARKED_MISSING":
        state.status = "missing";
        state.missing_note = p.note;
        break;
      case "CUSTODY_CONFLICT_DETECTED":
        state.conflict = { conflict: p.conflict, rejected_event_ids: p.rejected_event_ids, at: event.occurred_at };
        break;
      default:
        break;
    }
    return state;
  },

  handlers: {
    CheckoutLoan(state, cmd, ctx) {
      requireRole(ctx, ["company_lead", "performance_manager"], "办理出库借用");
      if (state.loan) throw new DomainError("ALREADY_EXISTS", `借用单 ${cmd.loan_id} 已存在`);
      // 在线快速拦截：同一物件已有未结清借用
      const existing = ctx.registry?.loanByPuppet(cmd.puppet_id);
      if (existing) {
        throw new DomainError(
          "DUPLICATE_CUSTODY",
          `影偶 ${cmd.puppet_id} 已有未结清借用（${existing.loan.loan_id}，当前持有人 ${existing.current_custodian_id}），不能重复出库`,
        );
      }
      // 冻结部件的老件不得出库
      const puppetView = ctx.registry?.puppet(cmd.puppet_id);
      if (puppetView?.puppet) {
        const frozen = [...puppetView.parts.values()].filter((part) => part.status === "frozen").map((part) => part.part_id);
        if (puppetView.puppet.artifact_class === "antique" && frozen.length > 0) {
          throw new DomainError("PART_FROZEN", `老件存在冻结部件，禁止出库：${frozen.join("、")}`);
        }
      }
      return {
        eventType: "LOAN_CHECKED_OUT",
        summary: `影偶 ${cmd.puppet_id} 出库，持有人 ${cmd.custodian_id}（${cmd.purpose}）`,
        payload: {
          loan_id: cmd.loan_id,
          puppet_id: cmd.puppet_id,
          custodian_id: cmd.custodian_id,
          purpose: cmd.purpose,
          expected_return_at: cmd.expected_return_at,
        },
      };
    },

    TransferCustody(state, cmd, ctx) {
      requireRole(ctx, ["company_lead", "performance_manager"], "多人交接");
      assertOpen(state);
      if (cmd.from_custodian_id !== state.current_custodian_id) {
        throw new DomainError(
          "CUSTODY_MISMATCH",
          `交接无效：记录中当前持有人为 ${state.current_custodian_id}，不是 ${cmd.from_custodian_id}；同一物件不能出现两个当前位置`,
        );
      }
      if (cmd.to_custodian_id === cmd.from_custodian_id) {
        throw new DomainError("BAD_INPUT", "交接双方不能是同一人");
      }
      return {
        eventType: "CUSTODY_TRANSFERRED",
        summary: `影偶 ${state.puppet_id} 交接：${cmd.from_custodian_id} → ${cmd.to_custodian_id}`,
        payload: {
          loan_id: cmd.loan_id,
          puppet_id: state.puppet_id,
          from_custodian_id: cmd.from_custodian_id,
          to_custodian_id: cmd.to_custodian_id,
          handoff_note: cmd.handoff_note ?? "",
        },
      };
    },

    ReturnLoan(state, cmd, ctx) {
      assertOpen(state);
      if (cmd.returned_by !== state.current_custodian_id) {
        throw new DomainError(
          "CUSTODY_MISMATCH",
          `归还人 ${cmd.returned_by} 不是当前持有人 ${state.current_custodian_id}`,
        );
      }
      if (!Array.isArray(cmd.parts_checked) || cmd.parts_checked.length === 0) {
        throw new DomainError("BAD_INPUT", "归还必须逐部件清点（parts_checked）");
      }
      const missingParts = cmd.parts_checked.filter((x) => x.present === false).map((x) => x.part_id);
      const events = [
        {
          eventType: "LOAN_RETURNED",
          summary:
            missingParts.length === 0
              ? `影偶 ${state.puppet_id} 归还清点无误`
              : `影偶 ${state.puppet_id} 归还但清点异常：缺 ${missingParts.join("、")}`,
          payload: {
            loan_id: cmd.loan_id,
            puppet_id: state.puppet_id,
            returned_by: cmd.returned_by,
            condition_note: cmd.condition_note,
            parts_checked: cmd.parts_checked,
          },
        },
      ];
      if (missingParts.length > 0) {
        events.push({
          eventType: "ITEM_MARKED_MISSING",
          summary: `影偶 ${state.puppet_id} 归还清点缺失部件：${missingParts.join("、")}`,
          payload: {
            loan_id: cmd.loan_id,
            puppet_id: state.puppet_id,
            note: `归还缺失：${missingParts.join("、")}；${cmd.condition_note ?? ""}`,
          },
        });
      }
      return events;
    },
  },
};

function assertOpen(state) {
  if (!state.loan) throw new DomainError("NOT_FOUND", "借用单不存在");
  if (state.status === "returned") throw new DomainError("ALREADY_CLOSED", "借用已归还结清");
  if (state.status === "missing") throw new DomainError("ITEM_MISSING", "物件处于失踪状态，须先核查");
}
