import assert from "node:assert/strict";
import test from "node:test";

import { PART_CONDITION } from "../src/policy.js";
import { IDS, newApp, seedObjects, seedApprentices, qualify } from "./helpers.js";

/**
 * 端到端：一次乡村节庆巡演串起三类角色——
 * 演出经理不伤老件完成换场、修缮师从损伤追到最近使用与环境、传承人掌握学徒真实能力，
 * 并在事件重放后保持一致。
 */
test("端到端：报损冻结→复制品替角→修复留痕→追溯→能力视图→重放一致", () => {
  const app = newApp();
  seedObjects(app);
  seedApprentices(app);
  qualify(app, IDS.apprenticeAdult, "操控");
  qualify(app, IDS.apprenticeAdult, "修补");

  // 排期并派老件给成熟艺人（一级文物）
  app.performances.plan({
    performance_id: "PF-村戏", title: "鹤峰记", venue: "山村戏台",
    purpose: "正式演出",
    scheduled_start: "2026-09-25T19:30:00+08:00",
    scheduled_end: "2026-09-25T21:00:00+08:00",
    ticket_sold: true, planned_by: IDS.manager,
  });
  app.performances.castRole({
    performance_id: "PF-村戏", role_id: "ROLE-老旦", role_name: "老旦",
    object_id: IDS.old, operator_id: IDS.artist,
  });

  // 开演前高湿
  app.inventory.recordEnvironment({
    reading_id: "ENV-湿", location: "山村戏台", humidity: 78, temperature: 25,
    recorded_by: IDS.manager, performance_id: "PF-村戏",
  });
  // 临场又发现头茬虫蛀：只冻头茬
  app.inventory.reportDamage({
    object_id: IDS.old, reporter_id: IDS.artist,
    findings: [{ part_id: "P-头茬", condition: PART_CONDITION.WORM_EATEN, note: "虫孔多处" }],
  });

  // 经理视图：不就绪，且头茬以外部件未受株连，给出可用替身
  let status = app.managerShowStatus("PF-村戏", { reading_id: "ENV-湿" });
  assert.equal(status.ready, false);
  const roleView = status.roles[0];
  assert.deepEqual(roleView.frozen_parts.map((p) => p.part_id), ["P-头茬"]);
  assert.equal(roleView.approved_backups[0].replica_id, IDS.replica);
  assert.equal(status.ticket_sold, true, "已售票只是事实，不改变就绪结论");

  // 换戏：改派核准复制品，老件撤下
  const sub = app.performances.substituteRole({
    performance_id: "PF-村戏", role_id: "ROLE-老旦", decided_by: IDS.manager,
    reason: "头茬虫蛀且现场高湿",
  });
  assert.equal(sub.to_object_id, IDS.replica);

  // 湿度回落，复制品重新核验通过，演出就绪
  app.inventory.recordEnvironment({
    reading_id: "ENV-干", location: "山村戏台", humidity: 55, temperature: 22,
    recorded_by: IDS.manager, performance_id: "PF-村戏",
  });
  app.performances.requestClearance({
    performance_id: "PF-村戏", role_id: "ROLE-老旦", reading_id: "ENV-干", requested_by: IDS.manager,
  });
  app.performances.decideClearance({ performance_id: "PF-村戏", role_id: "ROLE-老旦", decided_by: IDS.restorer });
  status = app.managerShowStatus("PF-村戏", { reading_id: "ENV-干" });
  assert.equal(status.ready, true, "经理在不伤老件前提下完成换场");
  assert.equal(status.roles[0].object_id, IDS.replica);

  // 修缮师处理头茬：两层修复（返工留痕）后复检解冻
  app.inventory.recordRepair({
    repair_id: "FX-头-1", object_id: IDS.old, part_id: "P-头茬",
    restorer_id: IDS.restorer, materials: ["苦楝虫液", "棉纸"], techniques: ["除虫封护"], note: "除虫第一层",
  });
  app.inventory.recordRepair({
    repair_id: "FX-头-2", object_id: IDS.old, part_id: "P-头茬",
    restorer_id: IDS.restorer, apprentice_id: IDS.apprenticeAdult,
    materials: ["矿粉皮浆"], techniques: ["随色补面"], note: "补面第二层，保留旧补痕",
  });
  app.inventory.clearPart({ object_id: IDS.old, part_id: "P-头茬", inspector_id: IDS.restorer });

  // 修缮师追溯：虫蛀 → 最近使用场次与当时环境、修复层次
  const trace = app.restorerTrace(IDS.old);
  const head = trace.damaged_parts.find((p) => p.part_id === "P-头茬");
  assert.equal(head.damage_events[0].condition, "虫蛀");
  assert.equal(head.repairs.length, 2);
  const recentOldUse = trace.recent_uses.find((u) => u.is_current_cast === false || true);
  assert.equal(recentOldUse.performance_id, "PF-村戏");
  // 该场次绑定的正是高湿读数
  assert.equal(recentOldUse.environment.reading_id, "ENV-湿");
  assert.equal(recentOldUse.environment.safe, false);

  // 传承人：阿英具备独立操控与修补，小禾仍只可复制品
  const report = app.masterApprenticeReport();
  const aying = report.find((a) => a.apprentice_id === IDS.apprenticeAdult);
  const xiaohe = report.find((a) => a.apprentice_id === IDS.apprenticeMinor);
  assert.equal(aying.can_manipulate_independently, true);
  assert.equal(aying.can_repair_independently, true);
  assert.equal(xiaohe.handling_level, "仅复制品");

  // 事件不可变：所有结论可由事件流重放还原
  const events = app.eventLog;
  const reborn = newApp().rehydrate(events);
  const status2 = reborn.managerShowStatus("PF-村戏", { reading_id: "ENV-干" });
  assert.equal(status2.ready, true);
  assert.equal(status2.roles[0].object_id, IDS.replica);
  const trace2 = reborn.restorerTrace(IDS.old);
  assert.equal(trace2.damaged_parts.find((p) => p.part_id === "P-头茬").repairs.length, 2);
  assert.equal(reborn.custody.currentLocation(IDS.old).location, "传习所库房");

  // 版本号按聚合单调
  const puppetEvents = events.filter((e) => e.aggregate_type === "puppet_object" && e.aggregate_id === IDS.old);
  const versions = puppetEvents.map((e) => e.version);
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b));
});
