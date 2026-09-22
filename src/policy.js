/**
 * 领域策略常量：文物保全门槛、环境安全区间、学徒训练层级与接触级别。
 * 这些阈值是领域知识，不属于某一次调用，因此集中在此并允许负责人复核调整。
 */

export const RELIC_GRADES = Object.freeze({
  /** 国家一/二级文物，四百余年老件多在此列，默认禁止日常上台 */
  FIRST_CLASS: "一级文物",
  SECOND_CLASS: "二级文物",
  /** 一般文物：经核验可在受控条件下上台 */
  ORDINARY: "一般文物",
  /** 近现代道具、教学用具 */
  MODERN: "现代道具",
  /** 经核准的复制替身 */
  REPLICA: "核准复制品",
});

/** 各文物等级默认能否进入日常商演；一级文物仍可通过逐场书面授权特批。 */
export const DEFAULT_STAGE_ALLOWANCE = Object.freeze({
  [RELIC_GRADES.FIRST_CLASS]: false,
  [RELIC_GRADES.SECOND_CLASS]: true,
  [RELIC_GRADES.ORDINARY]: true,
  [RELIC_GRADES.MODERN]: true,
  [RELIC_GRADES.REPLICA]: true,
});

/** 部件保存状态。 */
export const PART_CONDITION = Object.freeze({
  SOUND: "完好",
  CRACKED: "开裂",
  WORM_EATEN: "虫蛀",
  BRITTLE: "酥脆",
  REPAIRED: "已修复待复检",
});

/** 只有这些状态的部件允许上台；修复后须复检合格（PART_CLEARED）才回到“完好”。 */
export const STAGE_READY_CONDITIONS = Object.freeze(new Set([PART_CONDITION.SOUND]));

/** 演出环境安全区间（超出即构成老件上台的一票否决因子）。 */
export const ENV_LIMITS = Object.freeze({
  humidity: { min: 45, max: 65, unit: "%RH", label: "相对湿度" },
  temperature: { min: 15, max: 28, unit: "℃", label: "温度" },
});

/** 道具接触级别：未成年人只能接触获准级别（硬封顶为复制品）。 */
export const HANDLING_LEVELS = Object.freeze({
  /** 仅可接触核准复制品 */
  REPLICA_ONLY: "仅复制品",
  /** 可接触一般/现代道具 */
  MODERN_OBJECTS: "现代及一般文物",
  /** 可接触二级文物 */
  SECOND_CLASS: "二级文物",
  /** 可接触一级文物（须师傅在场） */
  FIRST_CLASS_ASSISTED: "一级文物（师傅在场）",
});

/** 接触级别由低到高，用于比较与封顶。 */
export const HANDLING_LEVEL_ORDER = Object.freeze([
  HANDLING_LEVELS.REPLICA_ONLY,
  HANDLING_LEVELS.MODERN_OBJECTS,
  HANDLING_LEVELS.SECOND_CLASS,
  HANDLING_LEVELS.FIRST_CLASS_ASSISTED,
]);

/** 未成年学徒的硬封顶：无论资格如何，都不得独立接触真品老件。 */
export const MINOR_HANDLING_CEILING = HANDLING_LEVELS.REPLICA_ONLY;

/**
 * 学徒训练科目及层级。每科必须逐级完成训练记录并通过师傅复核，
 * 才能取得对应独立资格；不得跳级。
 */
export const TRAINING_DISCIPLINES = Object.freeze({
  /** 独立操控：影窗表演 */
  MANIPULATION: "操控",
  /** 独立制作：新件/部件制作 */
  MAKING: "制作",
  /** 独立修补：传统修复作业 */
  REPAIR: "修补",
});

/** 每科的层级阶梯（由低到高）。 */
export const TRAINING_LEVELS = Object.freeze({
  [TRAINING_DISCIPLINES.MANIPULATION]: ["观摩", "把杆辅助", "复制品独立", "真品协演", "独立操控"],
  [TRAINING_DISCIPLINES.MAKING]: ["制皮观摩", "基础裁切", "组装成型", "独立制作"],
  [TRAINING_DISCIPLINES.REPAIR]: ["修复观摩", "辅料备制", "复制品试修", "配补作业", "独立修补"],
});

/** 各科最后一级即“取得该科独立资格”的标志级。 */
export const INDEPENDENT_LEVEL = Object.freeze({
  [TRAINING_DISCIPLINES.MANIPULATION]: "独立操控",
  [TRAINING_DISCIPLINES.MAKING]: "独立制作",
  [TRAINING_DISCIPLINES.REPAIR]: "独立修补",
});

/**
 * 未成年学徒在各科可完成的最高层级：再往上就要接触真品，被硬封顶挡住。
 * 制作科全程制作新件、不涉真品，故不封顶。
 */
export const MINOR_LEVEL_CEILING = Object.freeze({
  [TRAINING_DISCIPLINES.MANIPULATION]: "复制品独立",
  [TRAINING_DISCIPLINES.MAKING]: "独立制作",
  [TRAINING_DISCIPLINES.REPAIR]: "复制品试修",
});

/** 修补资格与可接触文物等级的对应（未取得修补资格者不得对真品动刀）。 */
export const REPAIR_MIN_DISCIPLINE_LEVEL = Object.freeze({
  [RELIC_GRADES.MODERN]: "复制品试修",
  [RELIC_GRADES.ORDINARY]: "配补作业",
  [RELIC_GRADES.SECOND_CLASS]: "独立修补",
  [RELIC_GRADES.FIRST_CLASS]: "独立修补",
});

/** 排演用途。 */
export const REHEARSAL_PURPOSES = Object.freeze({
  REHEARSAL: "排练",
  PERFORMANCE: "正式演出",
});

/** 保管链位置类型。 */
export const LOCATION_TYPES = Object.freeze({
  STORAGE: "传习所库房",
  PERSON: "责任人随身",
  VENUE: "巡演场地",
  IN_TRANSIT: "在途",
  DISPUTED: "位置争议（待复核）",
});

/**
 * 判断环境读数是否在安全区间内。
 * @returns {{safe: boolean, violations: string[]}}
 */
export function assessEnvironment(reading) {
  const violations = [];
  for (const [key, limit] of Object.entries(ENV_LIMITS)) {
    const value = reading[key];
    if (value === undefined || value === null) {
      violations.push(`缺少${limit.label}读数`);
    } else if (value < limit.min || value > limit.max) {
      violations.push(`${limit.label} ${value}${limit.unit} 超出安全区间 ${limit.min}–${limit.max}${limit.unit}`);
    }
  }
  return { safe: violations.length === 0, violations };
}

/** 比较两个接触级别：a 是否不低于 b。 */
export function handlingLevelAtLeast(a, b) {
  return HANDLING_LEVEL_ORDER.indexOf(a) >= HANDLING_LEVEL_ORDER.indexOf(b);
}
