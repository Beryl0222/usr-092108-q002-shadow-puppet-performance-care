/**
 * 学徒训练服务：分层训练逐级推进、师傅复核、独立资格授权、接触级别判定。
 *
 * 推进规则：
 * - 每一层级必须先有训练记录，才能由本门师傅复核；
 * - 上一层级复核通过，才允许登记下一层级训练（不得跳级）；
 * - 该科全部层级复核通过后，师傅方可授予独立资格（操控/制作/修补）；
 * - 未成年人即使取得资格，接触级别仍被硬封顶为“仅复制品”。
 */
import { DomainError } from "../errors.js";
import {
  HANDLING_LEVELS,
  INDEPENDENT_LEVEL,
  MINOR_HANDLING_CEILING,
  MINOR_LEVEL_CEILING,
  TRAINING_DISCIPLINES,
  TRAINING_LEVELS,
  RELIC_GRADES,
  handlingLevelAtLeast,
} from "../policy.js";

export class TrainingService {
  #store;
  #view;

  constructor({ store, view }) {
    this.#store = store;
    this.#view = view;
  }

  enroll({ apprentice_id, name, minor, master_id }) {
    if (this.#view.apprentices.has(apprentice_id))
      throw new DomainError("APPRENTICE_EXISTS", `学徒已登记：${apprentice_id}`);
    return this.#store.append("APPRENTICE_ENROLLED", apprentice_id, {
      apprentice_id, name, minor, master_id,
    }, { summary: `学徒 ${name} 入门（${minor ? "未成年" : "成年"}），师傅 ${master_id}` });
  }

  logTraining({ apprentice_id, discipline, level, logged_by, note }) {
    const app = this.#requireApprentice(apprentice_id);
    const ladder = this.#ladder(discipline, level);
    const idx = ladder.indexOf(level);
    if (app.minor) {
      const ceilingIdx = ladder.indexOf(MINOR_LEVEL_CEILING[discipline]);
      if (idx > ceilingIdx)
        throw new DomainError(
          "MINOR_LEVEL_FORBIDDEN",
          `未成年学徒在${discipline}科最高只能到「${MINOR_LEVEL_CEILING[discipline]}」，「${level}」需接触真品，须成年后再修`
        );
    }
    if (idx > 0) {
      const prev = ladder[idx - 1];
      const passed = (app.training[discipline]?.[prev]?.reviews ?? []).some((r) => r.passed);
      if (!passed)
        throw new DomainError(
          "LEVEL_LOCKED",
          `未完成上一层级「${prev}」的复核，不能进入「${level}」`
        );
    }
    return this.#store.append("TRAINING_LOGGED", apprentice_id, {
      apprentice_id, discipline, level, logged_by, note,
    }, { summary: `${app.name} 登记${discipline}训练：${level}` });
  }

  review({ apprentice_id, discipline, level, reviewer_id, passed, note }) {
    const app = this.#requireApprentice(apprentice_id);
    this.#ladder(discipline, level);
    if (reviewer_id !== app.master_id)
      throw new DomainError("NOT_MASTER", `只有本门师傅 ${app.master_id} 可以复核`);
    const state = app.training[discipline]?.[level];
    if (!state?.logged_at)
      throw new DomainError("TRAINING_NOT_LOGGED", `尚未登记「${level}」训练，不能复核`);
    return this.#store.append("TRAINING_REVIEWED", apprentice_id, {
      apprentice_id, discipline, level, reviewer_id, passed, note,
    }, { summary: `师傅复核 ${app.name}「${level}」：${passed ? "通过" : "未通过"}` });
  }

  /**
   * 授予某科独立资格。仅授予末级（独立操控/独立制作/独立修补），
   * 且该科每一层级都须有通过的复核。
   */
  grantQualification({ apprentice_id, discipline, granted_by }) {
    const app = this.#requireApprentice(apprentice_id);
    const ladder = TRAINING_LEVELS[discipline];
    const level = INDEPENDENT_LEVEL[discipline];
    if (granted_by !== app.master_id)
      throw new DomainError("NOT_MASTER", `只有本门师傅可以授予独立资格`);
    const disc = app.training[discipline] ?? {};
    const missing = ladder.filter(
      (lv) => !(disc[lv]?.reviews ?? []).some((r) => r.passed)
    );
    if (missing.length)
      throw new DomainError(
        "STEPS_INCOMPLETE",
        `${app.name} 尚有层级未通过复核：${missing.join("、")}，不能授予${level}资格`
      );
    return this.#store.append("QUALIFICATION_GRANTED", apprentice_id, {
      apprentice_id, discipline, level, granted_by,
    }, {
      summary: app.minor
        ? `${app.name} 取得${level}能力（未成年，独立接触仍限复制品）`
        : `${app.name} 取得${level}资格`,
    });
  }

  /** 学徒当前可独立接触的道具级别（未成年硬封顶）。 */
  handlingLevel(apprenticeId) {
    const app = this.#view.apprentices.get(apprenticeId);
    if (!app) return null;
    if (app.minor) return MINOR_HANDLING_CEILING;

    const qualified = (d) => Boolean(app.training[d]?.[INDEPENDENT_LEVEL[d]]?.qualified_at);
    if (qualified(TRAINING_DISCIPLINES.REPAIR)) return HANDLING_LEVELS.FIRST_CLASS_ASSISTED;
    if (qualified(TRAINING_DISCIPLINES.MANIPULATION) || qualified(TRAINING_DISCIPLINES.MAKING))
      return HANDLING_LEVELS.SECOND_CLASS;
    return HANDLING_LEVELS.MODERN_OBJECTS;
  }

  /**
   * 断言某人可操控/接触某等级道具。
   * @param {string} person_id 可能是学徒，也可能是不在学徒册的成熟艺人
   * @param {string} grade 文物等级
   * @param {boolean} masterPresent 师傅是否在场（一级文物必需）
   */
  assertMayHandle({ person_id, grade, masterPresent = false }) {
    const app = this.#view.apprentices.get(person_id);
    if (!app) return; // 学徒册之外视为已出师艺人，自行负责
    const required = REQUIRED_HANDLING[grade];
    if (!required) return;
    const level = this.handlingLevel(person_id);
    if (!handlingLevelAtLeast(level, required.level))
      throw new DomainError(
        "HANDLING_FORBIDDEN",
        `${app.name}（${level}）不得接触${grade}道具，需要「${required.level}」`,
        { person_id: person_id, grade, current: level, required: required.level }
      );
    if (required.masterPresent && !masterPresent)
      throw new DomainError(
        "MASTER_REQUIRED",
        `接触${grade}必须有师傅在场`,
        { person_id: person_id, grade }
      );
  }

  /**
   * 修缮作业资格：修缮师（非学徒册成员）默认可担真品修复；
   * 学徒参与须在修补科达到所需层级并通过复核；未成年学徒只能在复制品上动手。
   */
  assertMayRepair({ person_id, apprentice_id, grade, requiredLevel }) {
    if (apprentice_id) {
      const app = this.#requireApprentice(apprentice_id);
      if (app.minor && grade !== RELIC_GRADES.REPLICA && grade !== RELIC_GRADES.MODERN)
        throw new DomainError(
          "MINOR_REPAIR_FORBIDDEN",
          `未成年学徒只能在复制品/现代道具上练习修补，不得对真品动手`,
          { apprentice_id, grade }
        );
      const ladder = TRAINING_LEVELS[TRAINING_DISCIPLINES.REPAIR];
      const needIdx = ladder.indexOf(requiredLevel);
      const disc = app.training[TRAINING_DISCIPLINES.REPAIR] ?? {};
      const reached = highestPassedIndex(ladder, disc);
      if (reached < needIdx)
        throw new DomainError(
          "REPAIR_LEVEL_INSUFFICIENT",
          `${app.name} 修补层级「${ladder[reached] ?? "未开始"}」不足以参与${grade}修复，需要「${requiredLevel}」`,
          { apprentice_id, grade, required: requiredLevel }
        );
    }
    // 修缮师本人若也是学徒册成员，同样按其修补层级核验
    if (person_id && person_id !== apprentice_id) {
      const restorer = this.#view.apprentices.get(person_id);
      if (restorer) {
        const ladder = TRAINING_LEVELS[TRAINING_DISCIPLINES.REPAIR];
        const needIdx = ladder.indexOf(requiredLevel);
        const disc = restorer.training[TRAINING_DISCIPLINES.REPAIR] ?? {};
        const reached = highestPassedIndex(ladder, disc);
        if (reached < needIdx)
          throw new DomainError(
            "REPAIR_LEVEL_INSUFFICIENT",
            `${restorer.name} 不具备${grade}修复所需的「${requiredLevel}」层级`,
            { person_id, grade, required: requiredLevel }
          );
      }
    }
  }

  #requireApprentice(id) {
    const app = this.#view.apprentices.get(id);
    if (!app) throw new DomainError("APPRENTICE_NOT_FOUND", `学徒不存在：${id}`);
    return app;
  }

  #ladder(discipline, level) {
    const ladder = TRAINING_LEVELS[discipline];
    if (!ladder) throw new DomainError("UNKNOWN_DISCIPLINE", `未知训练科目：${discipline}`);
    if (!ladder.includes(level))
      throw new DomainError("UNKNOWN_LEVEL", `${discipline}科不存在层级：${level}`);
    return ladder;
  }
}

/** 文物等级 -> 操控/接触所需级别。复制品与现代道具无门槛。 */
const REQUIRED_HANDLING = Object.freeze({
  [RELIC_GRADES.REPLICA]: null,
  [RELIC_GRADES.MODERN]: null,
  [RELIC_GRADES.ORDINARY]: { level: HANDLING_LEVELS.MODERN_OBJECTS, masterPresent: false },
  [RELIC_GRADES.SECOND_CLASS]: { level: HANDLING_LEVELS.SECOND_CLASS, masterPresent: false },
  // 一级文物：具备二级独立资格者，在师傅在场时方可协演
  [RELIC_GRADES.FIRST_CLASS]: { level: HANDLING_LEVELS.SECOND_CLASS, masterPresent: true },
});

/** 修补阶梯中“已通过师傅复核”的最高层级序号；无则 -1。 */
function highestPassedIndex(ladder, disc) {
  let reached = -1;
  ladder.forEach((lv, i) => {
    if ((disc[lv]?.reviews ?? []).some((r) => r.passed)) reached = i;
  });
  return reached;
}
