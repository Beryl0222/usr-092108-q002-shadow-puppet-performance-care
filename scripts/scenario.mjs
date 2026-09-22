/**
 * 端到端情景样例：鹤峰春生皮影剧团乡村节庆巡演。
 * 运行：node scripts/scenario.mjs
 * 同时把完整事件流写入 data/sample-flow.json，供离线终端与联调使用。
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { TroupeApplication } from "../src/services/app.js";
import {
  PART_CONDITION,
  REHEARSAL_PURPOSES,
  RELIC_GRADES,
  TRAINING_DISCIPLINES,
} from "../src/policy.js";
import { DomainError } from "../src/errors.js";

const app = new TroupeApplication();
const log = (title) => console.log(`\n■ ${title}`);
const section = (v) => console.log(JSON.stringify(v, null, 2));

// 1) 台账：四百余年的老件 + 一件核准复制品
app.inventory.registerObject({
  object_id: "PP-老旦-001",
  name: "老旦影偶（明万历传世）",
  grade: RELIC_GRADES.FIRST_CLASS,
  dynasty: "明万历",
  year_estimate: "约1580年代（四百余年）",
  registered_by: "传承人-田",
  parts: [
    { part_id: "P-头茬", name: "头茬", condition: PART_CONDITION.SOUND },
    { part_id: "P-胸腹", name: "胸腹", condition: PART_CONDITION.SOUND },
    { part_id: "P-左臂", name: "左臂", condition: PART_CONDITION.SOUND },
    { part_id: "P-右臂", name: "右臂", condition: PART_CONDITION.SOUND },
  ],
});
app.inventory.setRepertoire({
  object_id: "PP-老旦-001",
  plays: ["鹤峰记", "碧潭会"],
  updated_by: "传承人-田",
});
app.inventory.registerObject({
  object_id: "RP-老旦-复刻A",
  name: "老旦复制品甲",
  grade: RELIC_GRADES.REPLICA,
  year_estimate: "2024年传统工艺复制",
  registered_by: "修缮师-覃",
  parts: [
    { part_id: "P-头茬", name: "头茬", condition: PART_CONDITION.SOUND },
    { part_id: "P-胸腹", name: "胸腹", condition: PART_CONDITION.SOUND },
    { part_id: "P-左臂", name: "左臂", condition: PART_CONDITION.SOUND },
    { part_id: "P-右臂", name: "右臂", condition: PART_CONDITION.SOUND },
  ],
});
app.inventory.setRepertoire({
  object_id: "RP-老旦-复刻A",
  plays: ["鹤峰记", "碧潭会"],
  updated_by: "传承人-田",
});
app.inventory.registerObject({
  object_id: "RP-小旦-复刻B",
  name: "小旦复制品乙",
  grade: RELIC_GRADES.REPLICA,
  year_estimate: "2025年传统工艺复制",
  registered_by: "修缮师-覃",
  parts: [
    { part_id: "P-头茬", name: "头茬", condition: PART_CONDITION.SOUND },
    { part_id: "P-胸腹", name: "胸腹", condition: PART_CONDITION.SOUND },
  ],
});
app.inventory.setRepertoire({
  object_id: "RP-小旦-复刻B",
  plays: ["鹤峰记"],
  updated_by: "传承人-田",
});
app.inventory.approveSubstitute({
  object_id: "PP-老旦-001",
  replica_id: "RP-老旦-复刻A",
  role_id: "ROLE-老旦",
  approved_by: "传承人-田",
  note: "头茬形制与操纵手感经核验一致",
});

// 2) 学徒：成年学徒阿英、未成年学徒小禾
app.training.enroll({ apprentice_id: "AP-阿英", name: "阿英", minor: false, master_id: "传承人-田" });
app.training.enroll({ apprentice_id: "AP-小禾", name: "小禾", minor: true, master_id: "传承人-田" });

// 阿英逐级完成操控科
for (const level of ["观摩", "把杆辅助", "复制品独立", "真品协演", "独立操控"]) {
  app.training.logTraining({ apprentice_id: "AP-阿英", discipline: TRAINING_DISCIPLINES.MANIPULATION, level, logged_by: "传承人-田" });
  app.training.review({ apprentice_id: "AP-阿英", discipline: TRAINING_DISCIPLINES.MANIPULATION, level, reviewer_id: "传承人-田", passed: true });
}
app.training.grantQualification({ apprentice_id: "AP-阿英", discipline: TRAINING_DISCIPLINES.MANIPULATION, granted_by: "传承人-田" });

// 阿英还完成了修补科全部层级，可在一级文物修复中给修缮师做配补助手
for (const level of ["修复观摩", "辅料备制", "复制品试修", "配补作业", "独立修补"]) {
  app.training.logTraining({ apprentice_id: "AP-阿英", discipline: TRAINING_DISCIPLINES.REPAIR, level, logged_by: "修缮师-覃" });
  app.training.review({ apprentice_id: "AP-阿英", discipline: TRAINING_DISCIPLINES.REPAIR, level, reviewer_id: "传承人-田", passed: true });
}
app.training.grantQualification({ apprentice_id: "AP-阿英", discipline: TRAINING_DISCIPLINES.REPAIR, granted_by: "传承人-田" });

// 小禾在复制品上完成操控训练并取得能力，但未成年封顶仍只可接触复制品
for (const level of ["观摩", "把杆辅助", "复制品独立"]) {
  app.training.logTraining({ apprentice_id: "AP-小禾", discipline: TRAINING_DISCIPLINES.MANIPULATION, level, logged_by: "传承人-田" });
  app.training.review({ apprentice_id: "AP-小禾", discipline: TRAINING_DISCIPLINES.MANIPULATION, level, reviewer_id: "传承人-田", passed: true });
}

// 3) 排期：已售票的乡村节庆场
app.performances.plan({
  performance_id: "PF-2026中秋-走马村",
  title: "鹤峰记",
  venue: "走马村晒谷场",
  purpose: REHEARSAL_PURPOSES.PERFORMANCE,
  scheduled_start: "2026-09-25T19:30:00+08:00",
  scheduled_end: "2026-09-25T21:00:00+08:00",
  ticket_sold: true,
  planned_by: "演出经理-向",
});
app.performances.castRole({
  performance_id: "PF-2026中秋-走马村",
  role_id: "ROLE-老旦",
  role_name: "老旦",
  object_id: "PP-老旦-001",
  operator_id: "艺人-周",
});

// 4) 高湿环境：即使已售票，三因子不通过也不得放行
app.inventory.recordEnvironment({
  reading_id: "ENV-0925-傍晚高湿",
  location: "走马村晒谷场",
  humidity: 82,
  temperature: 24,
  recorded_by: "演出经理-向",
  performance_id: "PF-2026中秋-走马村",
});
app.performances.requestClearance({
  performance_id: "PF-2026中秋-走马村",
  role_id: "ROLE-老旦",
  reading_id: "ENV-0925-傍晚高湿",
  requested_by: "演出经理-向",
});
app.performances.decideClearance({ performance_id: "PF-2026中秋-走马村", role_id: "ROLE-老旦", decided_by: "修缮师-覃" });
log("高湿夜场：售票但暂缓老件上台");
section(app.managerShowStatus("PF-2026中秋-走马村").roles[0].blocking_reasons);

// 5) 临场发现右臂开裂：只冻结右臂；换戏改派核准复制品
app.inventory.reportDamage({
  object_id: "PP-老旦-001",
  reporter_id: "艺人-周",
  findings: [{ part_id: "P-右臂", condition: PART_CONDITION.CRACKED, note: "袖根处见横向裂纹" }],
});
app.performances.substituteRole({
  performance_id: "PF-2026中秋-走马村",
  role_id: "ROLE-老旦",
  decided_by: "演出经理-向",
  reason: "老旦右臂开裂且现场高湿，改派复制品",
});

// 复制品由小禾操控——未成年只可接触复制品，合规；若派真品则当场被拒
app.performances.castRole({
  performance_id: "PF-2026中秋-走马村",
  role_id: "ROLE-小旦",
  role_name: "小旦",
  object_id: "RP-小旦-复刻B",
  operator_id: "AP-小禾",
});
try {
  app.performances.castRole({
    performance_id: "PF-2026中秋-走马村",
    role_id: "ROLE-试派真品",
    role_name: "试派真品",
    object_id: "PP-老旦-001",
    operator_id: "AP-小禾",
  });
} catch (e) {
  if (e instanceof DomainError) log("未成年学徒被真品派戏拒绝：" + e.code);
}

// 湿度回落后复测
app.inventory.recordEnvironment({
  reading_id: "ENV-0925-开演复测",
  location: "走马村晒谷场",
  humidity: 60,
  temperature: 23,
  recorded_by: "演出经理-向",
  performance_id: "PF-2026中秋-走马村",
});
for (const roleId of ["ROLE-老旦", "ROLE-小旦"]) {
  app.performances.requestClearance({
    performance_id: "PF-2026中秋-走马村",
    role_id: roleId,
    reading_id: "ENV-0925-开演复测",
    requested_by: "演出经理-向",
  });
  app.performances.decideClearance({ performance_id: "PF-2026中秋-走马村", role_id: roleId, decided_by: "修缮师-覃" });
}
log("湿度回落、改派复制品后：演出就绪（老件未带伤上台）");
const status = app.managerShowStatus("PF-2026中秋-走马村", { reading_id: "ENV-0925-开演复测" });
console.log("全场就绪：", status.ready, "｜老旦现在使用：", status.roles.find((r) => r.role_id === "ROLE-老旦").object_name);

// 6) 传统修复分层留痕（返工不覆盖旧痕）
app.inventory.recordRepair({
  repair_id: "FX-右臂-01",
  object_id: "PP-老旦-001",
  part_id: "P-右臂",
  restorer_id: "修缮师-覃",
  materials: ["传统驴皮鳔胶", "同色矿粉"],
  techniques: ["裂纹对合", "薄皮背衬"],
  note: "第一层：原位粘合，保留断口旧痕",
});
app.inventory.recordRepair({
  repair_id: "FX-右臂-02",
  object_id: "PP-老旦-001",
  part_id: "P-右臂",
  restorer_id: "修缮师-覃",
  apprentice_id: "AP-阿英",
  materials: ["核桃油"],
  techniques: ["缓性回润"],
  note: "第二层返工：回润养护，不改动第一层粘痕",
});
app.inventory.clearPart({ object_id: "PP-老旦-001", part_id: "P-右臂", inspector_id: "修缮师-覃", note: "复检裂纹稳定，解冻" });

// 7) 巡演保管链：离线携出 → 交接，重传幂等
const deviceA = { client_id: "device-向经理", client_seq: 1, previous_event_id: null };
app.custody.checkOut({
  object_id: "PP-老旦-001",
  holder_id: "艺人-周",
  holder_name: "艺人周师傅",
  purpose: "走马村中秋场",
  location: "走马村晒谷场",
  handler_id: "演出经理-向",
  offline: deviceA,
});
const firstCheckout = app.custody.currentLocation("PP-老旦-001");
app.custody.checkOut({
  object_id: "PP-老旦-001",
  holder_id: "艺人-周",
  holder_name: "艺人周师傅",
  purpose: "走马村中秋场",
  location: "走马村晒谷场",
  handler_id: "演出经理-向",
  offline: deviceA, // 弱网重发同一序号
});
log("离线弱网重发：当前位置仍是同一个，不会出现两个持有人");
console.log(firstCheckout);

// 两台离线终端各自交接 → 分叉 → 冻结为待复核
const tailAfterCheckout = app.eventLog.filter((e) => e.aggregate_type === "custody_record").slice(-1)[0].event_id;
app.custody.transfer({
  object_id: "PP-老旦-001",
  from_holder_id: "艺人-周",
  to_holder_id: "stagehand-李",
  to_holder_name: "箱台李师傅",
  location: "村戏台后场",
  handler_id: "device-后场",
  offline: { client_id: "device-后场", client_seq: 1, previous_event_id: tailAfterCheckout },
});
const disputed = app.custody.transfer({
  object_id: "PP-老旦-001",
  from_holder_id: "艺人-周",
  to_holder_id: "driver-王",
  to_holder_name: "押运王师傅",
  location: "返程车上",
  handler_id: "device-押运",
  offline: { client_id: "device-押运", client_seq: 1, previous_event_id: tailAfterCheckout },
});
log("两台离线终端同时主张持有：位置冻结为待复核");
console.log(app.custody.currentLocation("PP-老旦-001"));
try {
  app.custody.checkOut({ object_id: "PP-老旦-001", holder_id: "x", holder_name: "x", purpose: "x", location: "x", handler_id: "x" });
} catch (e) {
  if (e instanceof DomainError) console.log("争议期间再借被拒：", e.code);
}
app.custody.reconcile({
  object_id: "PP-老旦-001",
  holder_id: "stagehand-李",
  location: "村戏台后场",
  reconciled_by: "演出经理-向",
  note: "电话核实：影偶确在李师傅箱内，押运车装的是道具箱",
});

// 归还清点
app.custody.transfer({
  object_id: "PP-老旦-001",
  from_holder_id: "stagehand-李",
  to_holder_id: "艺人-周",
  to_holder_name: "艺人周师傅",
  location: "返程车上",
  handler_id: "演出经理-向",
});
app.custody.returnObject({
  object_id: "PP-老旦-001",
  returned_by: "艺人-周",
  received_by: "库管-赵",
  location: "传习所库房",
  checked_part_ids: ["P-头茬", "P-胸腹", "P-左臂", "P-右臂"],
});

// 8) 修缮师：从右臂裂纹追到最近使用与当时高湿环境
log("修缮师追溯：右臂裂纹 → 最近场次与环境");
const trace = app.restorerTrace("PP-老旦-001");
console.log("受损部件：", trace.damaged_parts.map((p) => `${p.name}（${p.condition}）`));
console.log("最近使用：", trace.recent_uses[0].title, trace.recent_uses[0].venue, "环境：", trace.recent_uses[0].environment?.humidity, "%RH");
console.log("修复层次数：", trace.damaged_parts.find((p) => p.part_id === "P-右臂").repairs.length);

// 9) 传承人：学徒真实能力
log("传承人视图：学徒真实能力");
for (const a of app.masterApprenticeReport()) {
  console.log(
    `${a.name}（${a.minor ? "未成年" : "成年"}）：独立操控=${a.can_manipulate_independently} ` +
    `独立制作=${a.can_make_independently} 独立修补=${a.can_repair_independently} 实际接触级别=${a.handling_level}`
  );
}

await writeFile(
  fileURLToPath(new URL("../data/sample-flow.json", import.meta.url)),
  JSON.stringify(app.eventLog, null, 2) + "\n",
  "utf8"
);
console.log(`\n已写出 ${app.eventLog.length} 条事件到 data/sample-flow.json`);
