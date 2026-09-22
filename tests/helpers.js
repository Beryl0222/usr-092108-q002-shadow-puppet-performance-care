import { TroupeApplication } from "../src/services/app.js";
import {
  PART_CONDITION,
  REHEARSAL_PURPOSES,
  RELIC_GRADES,
  TRAINING_DISCIPLINES,
  TRAINING_LEVELS,
} from "../src/policy.js";

export function newApp() {
  return new TroupeApplication();
}

export const IDS = {
  old: "PP-老旦-001",
  replica: "RP-老旦-复刻A",
  second: "PP-武将-002",
  apprenticeAdult: "AP-阿英",
  apprenticeMinor: "AP-小禾",
  master: "传承人-田",
  restorer: "修缮师-覃",
  manager: "演出经理-向",
  artist: "艺人-周",
};

/** 登记一件四部件完好老件 + 一件同角色核准复制品。 */
export function seedObjects(app) {
  app.inventory.registerObject({
    object_id: IDS.old,
    name: "老旦影偶（明万历传世）",
    grade: RELIC_GRADES.FIRST_CLASS,
    dynasty: "明万历",
    year_estimate: "约1580年代",
    registered_by: IDS.master,
    parts: ["头茬", "胸腹", "左臂", "右臂"].map((n) => ({
      part_id: `P-${n}`,
      name: n,
      condition: PART_CONDITION.SOUND,
    })),
  });
  app.inventory.setRepertoire({ object_id: IDS.old, plays: ["鹤峰记", "碧潭会"], updated_by: IDS.master });
  app.inventory.registerObject({
    object_id: IDS.replica,
    name: "老旦复制品甲",
    grade: RELIC_GRADES.REPLICA,
    year_estimate: "2024年复制",
    registered_by: IDS.restorer,
    parts: ["头茬", "胸腹", "左臂", "右臂"].map((n) => ({
      part_id: `P-${n}`,
      name: n,
      condition: PART_CONDITION.SOUND,
    })),
  });
  app.inventory.setRepertoire({ object_id: IDS.replica, plays: ["鹤峰记", "碧潭会"], updated_by: IDS.master });
  app.inventory.approveSubstitute({
    object_id: IDS.old,
    replica_id: IDS.replica,
    role_id: "ROLE-老旦",
    approved_by: IDS.master,
  });
}

export function seedApprentices(app) {
  app.training.enroll({ apprentice_id: IDS.apprenticeAdult, name: "阿英", minor: false, master_id: IDS.master });
  app.training.enroll({ apprentice_id: IDS.apprenticeMinor, name: "小禾", minor: true, master_id: IDS.master });
}

/** 让学徒在某科逐级训练、复核直至末级，并授予独立资格。 */
export function qualify(a, apprenticeId, discipline, reviewer = IDS.master) {
  const ladder = TRAINING_LEVELS[discipline];
  for (const level of ladder) {
    a.training.logTraining({ apprentice_id: apprenticeId, discipline, level, logged_by: reviewer });
    a.training.review({ apprentice_id: apprenticeId, discipline, level, reviewer_id: reviewer, passed: true });
  }
  a.training.grantQualification({ apprentice_id: apprenticeId, discipline, granted_by: reviewer });
}

export function seedShow(app, { ticket_sold = true } = {}) {
  app.performances.plan({
    performance_id: "PF-中秋场",
    title: "鹤峰记",
    venue: "走马村晒谷场",
    purpose: REHEARSAL_PURPOSES.PERFORMANCE,
    scheduled_start: "2026-09-25T19:30:00+08:00",
    scheduled_end: "2026-09-25T21:00:00+08:00",
    ticket_sold,
    planned_by: IDS.manager,
  });
}

export function safeReading(app, id = "ENV-安全") {
  app.inventory.recordEnvironment({
    reading_id: id,
    location: "走马村晒谷场",
    humidity: 58,
    temperature: 23,
    recorded_by: IDS.manager,
    performance_id: "PF-中秋场",
  });
}

export function humidReading(app, id = "ENV-高湿") {
  app.inventory.recordEnvironment({
    reading_id: id,
    location: "走马村晒谷场",
    humidity: 82,
    temperature: 24,
    recorded_by: IDS.manager,
    performance_id: "PF-中秋场",
  });
}

export { TRAINING_DISCIPLINES, RELIC_GRADES, PART_CONDITION };
