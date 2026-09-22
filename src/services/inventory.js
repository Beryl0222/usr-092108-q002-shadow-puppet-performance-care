/**
 * 影偶台账服务：实体登记、部件巡检与报损、分层修复、复检解冻、复制品核准、环境记录。
 */
import { DomainError } from "../errors.js";
import {
  PART_CONDITION,
  RELIC_GRADES,
  REPAIR_MIN_DISCIPLINE_LEVEL,
  TRAINING_DISCIPLINES,
  TRAINING_LEVELS,
} from "../policy.js";

export class InventoryService {
  #store;
  #view;
  #training;

  /**
   * @param {object} deps
   * @param {import("../store.js").EventStore} deps.store
   * @param {import("../projection.js").Projection} deps.view
   * @param {import("./training.js").TrainingService} deps.training 用于核验修缮资格
   */
  constructor({ store, view, training }) {
    this.#store = store;
    this.#view = view;
    this.#training = training;
  }

  registerObject(input) {
    if (this.#view.objects.has(input.object_id))
      throw new DomainError("OBJECT_EXISTS", `影偶已登记：${input.object_id}`);
    const partIds = new Set();
    for (const part of input.parts) {
      if (partIds.has(part.part_id))
        throw new DomainError("DUPLICATE_PART", `部件标识重复：${part.part_id}`);
      partIds.add(part.part_id);
    }
    return this.#store.append("OBJECT_REGISTERED", input.object_id, {
      object_id: input.object_id,
      name: input.name,
      grade: input.grade,
      dynasty: input.dynasty,
      year_estimate: input.year_estimate,
      registered_by: input.registered_by,
      parts: input.parts.map((p) => ({ part_id: p.part_id, name: p.name, condition: p.condition })),
    }, { summary: `登记影偶《${input.name}》（${input.grade}）` });
  }

  setRepertoire({ object_id, plays, updated_by }) {
    this.#requireObject(object_id);
    return this.#store.append("REPERTOIRE_SET", object_id, {
      object_id,
      plays: [...new Set(plays)],
      updated_by,
    }, { summary: `更新《${this.#view.objects.get(object_id).name}》可用剧目 ${plays.length} 出` });
  }

  inspect({ object_id, inspector_id, findings, note }) {
    this.#requireObject(object_id);
    this.#requireParts(object_id, findings.map((f) => f.part_id));
    return this.#store.append("OBJECT_INSPECTED", object_id, {
      object_id,
      inspector_id,
      findings: findings.map((f) => ({ part_id: f.part_id, condition: f.condition, note: f.note })),
      note,
    }, { summary: `巡检 ${findings.length} 个部件` });
  }

  /**
   * 上报开裂/虫蛀/酥脆：只冻结相关部件，影偶其余部件仍可使用。
   */
  reportDamage({ object_id, reporter_id, findings }) {
    this.#requireObject(object_id);
    this.#requireParts(object_id, findings.map((f) => f.part_id));
    for (const f of findings) {
      if (f.condition === PART_CONDITION.SOUND || f.condition === PART_CONDITION.REPAIRED)
        throw new DomainError("NOT_DAMAGE", `损伤上报必须是开裂/虫蛀/酥脆：${f.part_id}`);
    }
    return this.#store.append("DAMAGE_REPORTED", object_id, {
      object_id,
      reporter_id,
      findings: findings.map((f) => ({ part_id: f.part_id, condition: f.condition, note: f.note })),
    }, { summary: `报损 ${findings.length} 个部件，仅冻结相关部件` });
  }

  /**
   * 记录一次传统修复（形成新的修复层次，永不覆盖旧层次）。
   * 修缮师资格按文物等级核验；学徒参与须达到对应层级，未成年人只能在复制品上练习。
   */
  recordRepair(input) {
    const obj = this.#requireObject(input.object_id);
    this.#requireParts(input.object_id, [input.part_id]);
    if (!input.materials?.length) throw new DomainError("MATERIALS_REQUIRED", "必须记录修复材料");
    if (!input.techniques?.length) throw new DomainError("TECHNIQUES_REQUIRED", "必须记录修复手法");

    const requiredLevel = REPAIR_MIN_DISCIPLINE_LEVEL[obj.grade];
    if (requiredLevel) {
      this.#training.assertMayRepair({
        person_id: input.restorer_id,
        apprentice_id: input.apprentice_id,
        grade: obj.grade,
        requiredLevel,
      });
    }

    const repairId = input.repair_id;
    return this.#store.append("REPAIR_RECORDED", repairId, {
      repair_id: repairId,
      object_id: input.object_id,
      part_id: input.part_id,
      restorer_id: input.restorer_id,
      apprentice_id: input.apprentice_id,
      materials: input.materials,
      techniques: input.techniques,
      note: input.note,
    }, { summary: `记录第 ${obj.repairs.length + 1} 层修复：${input.materials.join("、")}` });
  }

  /** 修复后由修缮师复检合格，部件才解冻。 */
  clearPart({ object_id, part_id, inspector_id, note }) {
    const obj = this.#requireObject(object_id);
    const part = obj.parts.get(part_id);
    if (!part) throw new DomainError("PART_NOT_FOUND", `部件不存在：${part_id}`);
    if (!part.frozen) throw new DomainError("PART_NOT_FROZEN", `部件 ${part.name} 当前未冻结，无需复检`);
    return this.#store.append("PART_CLEARED", object_id, {
      object_id, part_id, inspector_id, note,
    }, { summary: `复检合格，部件 ${part.name} 解冻` });
  }

  /**
   * 核准一件复制品作为某角色（行当/人物）的替身。
   * 替身本体必须先以“核准复制品”等级登记。
   */
  approveSubstitute({ object_id, replica_id, role_id, approved_by, note }) {
    this.#requireObject(object_id);
    const replica = this.#requireObject(replica_id);
    if (replica.grade !== RELIC_GRADES.REPLICA)
      throw new DomainError("NOT_A_REPLICA", `替身必须是核准复制品：${replica_id}`);
    return this.#store.append("SUBSTITUTE_APPROVED", object_id, {
      object_id, replica_id, role_id, approved_by, note,
    }, { summary: `核准复制品 ${replica.name} 接替角色 ${role_id}` });
  }

  recordEnvironment(input) {
    if (this.#view.environmentReadings.has(input.reading_id))
      throw new DomainError("READING_EXISTS", `环境读数已存在：${input.reading_id}`);
    return this.#store.append("ENVIRONMENT_RECORDED", input.reading_id, {
      reading_id: input.reading_id,
      location: input.location,
      humidity: input.humidity,
      temperature: input.temperature,
      recorded_by: input.recorded_by,
      performance_id: input.performance_id,
    }, { summary: `记录 ${input.location} 环境 ${input.humidity}%RH / ${input.temperature}℃` });
  }

  /** 部件冻结情况（供换场判断）。 */
  frozenParts(objectId, partIds = null) {
    const obj = this.#requireObject(objectId);
    const scope = partIds ? partIds : [...obj.parts.keys()];
    return scope
      .map((id) => obj.parts.get(id))
      .filter((part) => part && part.frozen);
  }

  #requireObject(objectId) {
    const obj = this.#view.objects.get(objectId);
    if (!obj) throw new DomainError("OBJECT_NOT_FOUND", `影偶不存在：${objectId}`);
    return obj;
  }

  #requireParts(objectId, partIds) {
    const obj = this.#view.objects.get(objectId);
    for (const id of partIds) {
      if (!obj.parts.has(id)) throw new DomainError("PART_NOT_FOUND", `部件不存在：${id}`);
    }
  }
}

export { TRAINING_DISCIPLINES, TRAINING_LEVELS };
