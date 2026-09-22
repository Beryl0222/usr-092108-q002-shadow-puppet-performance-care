/**
 * 演出排演服务：排期、派戏、上台许可三因子评估、临时换戏替角、收场。
 *
 * 老件是否上台由三个因子共同决定，缺一不可：
 *   1. 保存状态：派戏所用部件无一冻结（开裂/虫蛀/待复检）；
 *   2. 环境：演出地温湿度在安全区间；
 *   3. 授权：操控人具备对应文物等级的接触资格，一级文物另需逐场书面特批。
 * 节目已售票（ticket_sold）从不是放行理由，也不构成任何一个因子。
 * 文物保全因子（部件冻结、环境越限）不能用特批覆盖。
 */
import { DomainError } from "../errors.js";
import {
  DEFAULT_STAGE_ALLOWANCE,
  RELIC_GRADES,
  assessEnvironment,
} from "../policy.js";

export class PerformanceService {
  #store;
  #view;
  #training;

  constructor({ store, view, training }) {
    this.#store = store;
    this.#view = view;
    this.#training = training;
  }

  plan(input) {
    if (this.#view.performances.has(input.performance_id))
      throw new DomainError("PERFORMANCE_EXISTS", `演出已排期：${input.performance_id}`);
    if (input.scheduled_end <= input.scheduled_start)
      throw new DomainError("BAD_SCHEDULE", "收场时间必须晚于开场时间");
    return this.#store.append("PERFORMANCE_PLANNED", input.performance_id, {
      performance_id: input.performance_id,
      title: input.title,
      venue: input.venue,
      purpose: input.purpose,
      scheduled_start: input.scheduled_start,
      scheduled_end: input.scheduled_end,
      ticket_sold: input.ticket_sold,
      planned_by: input.planned_by,
    }, {
      summary: `排期《${input.title}》@${input.venue}（${input.purpose}${input.ticket_sold ? "，已售票" : ""}）`,
    });
  }

  /**
   * 派戏：把某角色连同影偶与操控人排进场次。
   * 影偶须在该剧目可用清单内；操控人接触资格当场校验（未成年人在此被挡在真品之外）。
   */
  castRole(input) {
    const show = this.#requirePerformance(input.performance_id);
    const obj = this.#requireObject(input.object_id);
    if (obj.repertoire.length && !obj.repertoire.includes(show.title))
      throw new DomainError(
        "NOT_IN_REPERTOIRE",
        `《${obj.name}》不在《${show.title}》的可用剧目清单内`,
        { object_id: input.object_id, title: show.title }
      );
    if (input.part_ids) {
      for (const pid of input.part_ids)
        if (!obj.parts.has(pid)) throw new DomainError("PART_NOT_FOUND", `部件不存在：${pid}`);
    }
    this.#training.assertMayHandle({
      person_id: input.operator_id,
      grade: obj.grade,
      masterPresent: input.master_present ?? false,
    });
    return this.#store.append("ROLE_CAST", input.performance_id, {
      performance_id: input.performance_id,
      role_id: input.role_id,
      role_name: input.role_name,
      object_id: input.object_id,
      operator_id: input.operator_id,
      part_ids: input.part_ids,
    }, { summary: `派戏 ${input.role_name}：《${obj.name}》/ ${input.operator_id}` });
  }

  /** 请求对某角色做上台核验（绑定一次环境读数）。 */
  requestClearance({ performance_id, role_id, reading_id, requested_by }) {
    const role = this.#requireRole(performance_id, role_id);
    const reading = this.#view.environmentReadings.get(reading_id);
    if (!reading) throw new DomainError("READING_NOT_FOUND", `环境读数不存在：${reading_id}`);
    return this.#store.append("STAGE_CLEARANCE_REQUESTED", performance_id, {
      performance_id,
      role_id,
      object_id: role.current.object_id,
      reading_id,
      requested_by,
    }, { summary: `请求上台核验：${role.role_name}` });
  }

  /**
   * 三因子评估并落结论。通过发 CLEARANCE_GRANTED，否则发 CLEARANCE_DENIED（记录拒绝理由）。
   * @param {object} input
   * @param {object} [input.special_approval] 一级文物逐场书面特批（reference/approver/reason）
   * @param {boolean} [input.master_present] 一级文物操控时师傅是否在场
   */
  decideClearance(input) {
    const show = this.#requirePerformance(input.performance_id);
    const role = this.#requireRole(input.performance_id, input.role_id);
    const request = role.pending_request;
    if (!request)
      throw new DomainError("NO_PENDING_REQUEST", `该角色没有待决的上台核验请求`);
    const reading = this.#view.environmentReadings.get(request.reading_id);

    const verdict = this.evaluate({
      performance: show,
      role,
      object_id: role.current.object_id,
      operator_id: role.current.operator_id,
      part_ids: role.current.part_ids,
      reading,
      special_approval: input.special_approval,
      master_present: input.master_present ?? false,
    });

    if (verdict.can_go_ahead) {
      return this.#store.append("CLEARANCE_GRANTED", input.performance_id, {
        performance_id: input.performance_id,
        role_id: input.role_id,
        object_id: verdict.object_id,
        granted_by: input.decided_by,
        scope_part_ids: verdict.checked_part_ids,
        special_approval: input.special_approval,
      }, { summary: `准许上台：${role.role_name}《${verdict.objectName}》（三因子通过）` });
    }

    return this.#store.append("CLEARANCE_DENIED", input.performance_id, {
      performance_id: input.performance_id,
      role_id: input.role_id,
      object_id: verdict.object_id,
      decided_by: input.decided_by,
      reasons: verdict.reasons,
    }, { summary: `暂缓上台：${role.role_name}（${verdict.reasons.join("；")}）` });
  }

  /**
   * 纯评估：返回三因子明细，不落事件。供决定前预判与临场复检使用。
   */
  evaluate({ performance, role, object_id, operator_id, part_ids, reading, special_approval, master_present }) {
    const reasons = [];
    const obj = this.#view.objects.get(object_id);
    if (!obj) throw new DomainError("OBJECT_NOT_FOUND", `影偶不存在：${object_id}`);

    // 因子一：保存状态
    const scope = part_ids ?? [...obj.parts.keys()];
    const frozen = scope
      .map((pid) => obj.parts.get(pid))
      .filter((part) => part && part.frozen);
    if (frozen.length)
      reasons.push(`部件冻结：${frozen.map((x) => `${x.name}（${x.condition}）`).join("、")}`);

    // 文物等级的默认上台限制；一级文物必须持逐场书面特批。特批只解除“等级默认限制”，
    // 不解除部件冻结与环境越限。
    if (!DEFAULT_STAGE_ALLOWANCE[obj.grade]) {
      const approvalOk =
        special_approval &&
        special_approval.reference &&
        special_approval.approver &&
        special_approval.reason;
      if (!approvalOk)
        reasons.push(`${obj.grade}默认不上台，须逐场书面特批（文号/批准人/理由齐全）`);
    }

    // 因子二：环境
    if (!reading) {
      reasons.push("缺少环境读数");
    } else {
      const env = assessEnvironment(reading);
      if (!env.safe) reasons.push(...env.violations);
    }

    // 因子三：授权（操控资格）。售票情况不在此处出现。
    try {
      this.#training.assertMayHandle({ person_id: operator_id, grade: obj.grade, masterPresent: master_present });
    } catch (err) {
      if (err instanceof DomainError) reasons.push(err.message);
      else throw err;
    }

    return {
      can_go_ahead: reasons.length === 0,
      object_id,
      objectName: obj.name,
      grade: obj.grade,
      checked_part_ids: scope,
      ticket_sold: performance?.ticket_sold ?? null, // 显式带回：售票不影响结论
      reasons,
    };
  }

  /**
   * 临时换戏/报损后为已排角色改派经过核准的复制品。
   * 仅当老件当前派戏部件存在冻结时允许；从该角色已核准替身中挑选一件
   * 能演本剧、状态完好的复制品。改派后须重新走上台核验。
   */
  substituteRole({ performance_id, role_id, decided_by, reason, preferred_replica_id }) {
    const show = this.#requirePerformance(performance_id);
    const role = this.#requireRole(performance_id, role_id);
    const original = this.#requireObject(role.current.object_id);
    const scope = role.current.part_ids ?? [...original.parts.keys()];
    const blocked = scope.some((pid) => original.parts.get(pid)?.frozen);
    if (!blocked)
      throw new DomainError(
        "SUBSTITUTION_UNNECESSARY",
        `《${original.name}》当前派戏部件并无冻结，不需替角；换角不能仅凭售票压力发起`
      );

    const approvedReplicaIds = [...(original.substitutes.keys() ?? [])].filter((rid) =>
      original.substitutes.get(rid).has(role_id)
    );
    const candidates = approvedReplicaIds
      .map((rid) => this.#view.objects.get(rid))
      .filter((r) =>
        r &&
        r.grade === RELIC_GRADES.REPLICA &&
        (r.repertoire.length === 0 || r.repertoire.includes(show.title)) &&
        ![...r.parts.values()].some((part) => part.frozen)
      );
    if (!candidates.length)
      throw new DomainError(
        "NO_APPROVED_SUBSTITUTE",
        `角色 ${role.role_name} 没有可用的核准复制品，该角色只能撤下或修复复检后再上，不得带伤硬演`,
        { object_id: original.object_id, role_id: role.role_id }
      );

    const chosen = preferred_replica_id
      ? candidates.find((r) => r.object_id === preferred_replica_id)
      : candidates[0];
    if (!chosen)
      throw new DomainError("SUBSTITUTE_NOT_ELIGIBLE", `指定的复制品不在该角色已核准替身清单内`);

    this.#store.append("ROLE_SUBSTITUTED", performance_id, {
      performance_id,
      role_id: role_id,
      from_object_id: original.object_id,
      to_object_id: chosen.object_id,
      reason: reason ?? "老件部件冻结，改派核准复制品",
      decided_by,
    }, { summary: `换角 ${role.role_name}：《${original.name}》→ 复制品《${chosen.name}》` });

    // 替身操控仍须资格合规：复制品无等级门槛，但若派给未成年学徒也只能是复制品——此处天然满足
    return { from_object_id: original.object_id, to_object_id: chosen.object_id };
  }

  /**
   * 临场开演前复检：用最新环境读数逐角色重算三因子，
   * 并核对许可对象与当前派戏一致（换角后旧许可自动失效）。
   */
  preShowCheck(performance_id, reading_id) {
    const show = this.#requirePerformance(performance_id);
    const reading = this.#view.environmentReadings.get(reading_id);
    if (!reading) throw new DomainError("READING_NOT_FOUND", `环境读数不存在：${reading_id}`);
    const roles = [...show.roles.values()].map((role) => {
      const obj = this.#view.objects.get(role.current.object_id);
      const clearanceValid =
        role.latest_clearance?.granted &&
        role.latest_clearance.object_id === role.current.object_id;
      const verdict = this.evaluate({
        performance: show,
        role,
        object_id: role.current.object_id,
        operator_id: role.current.operator_id,
        part_ids: role.current.part_ids,
        reading,
        special_approval: role.latest_clearance?.special_approval ?? null,
        master_present: true, // 临场复检时责任人在场；一级件资格仍按实际授权核验
      });
      return {
        role_id: role.role_id,
        role_name: role.role_name,
        object_id: obj.object_id,
        object_name: obj.name,
        clearance_on_record: Boolean(role.latest_clearance),
        clearance_valid_for_current_cast: clearanceValid,
        ...verdict,
      };
    });
    return {
      performance_id,
      can_go_ahead: roles.every((r) => r.can_go_ahead && r.clearance_valid_for_current_cast),
      roles,
    };
  }

  close({ performance_id, closed_by, note }) {
    this.#requirePerformance(performance_id);
    return this.#store.append("PERFORMANCE_CLOSED", performance_id, {
      performance_id, closed_by, note,
    }, { summary: `收场：${performance_id}` });
  }

  #requirePerformance(id) {
    const show = this.#view.performances.get(id);
    if (!show) throw new DomainError("PERFORMANCE_NOT_FOUND", `演出不存在：${id}`);
    return show;
  }

  #requireRole(performanceId, roleId) {
    const show = this.#requirePerformance(performanceId);
    const role = show.roles.get(roleId);
    if (!role?.current) throw new DomainError("ROLE_NOT_CAST", `角色未派戏：${roleId}`);
    return role;
  }

  #requireObject(id) {
    const obj = this.#view.objects.get(id);
    if (!obj) throw new DomainError("OBJECT_NOT_FOUND", `影偶不存在：${id}`);
    return obj;
  }
}
