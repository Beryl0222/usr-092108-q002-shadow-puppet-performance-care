import assert from "node:assert/strict";
import test from "node:test";

import {
  buildConservationTrace,
  buildCompetencyRoster,
  buildStageBoard,
  buildCustodyMap,
} from "../src/readModels.js";
import { ACTORS, newApp, registerPuppet } from "./helpers.js";

const { lead, manager, conservator, master } = ACTORS;

/**
 * 端到端：四百多年老件随团巡演 ——
 * 出库 → 授权上台 → 高湿季 → 发现虫蛀 → 冻结单部件 → 替身上台 →
 * 归还 → 修缮师从损伤追到最近使用与环境；传承人核对学徒真实能力。
 */
test("端到端：老件巡演全链路与三类角色的问题都有答案", () => {
  const app = newApp();
  const VENUE = "五里村草台";
  const SHOW = "2026-09-21T19:30:00+08:00";

  // 1) 建档：明代老件与登记在册的整偶替身
  registerPuppet(app, conservator, {
    puppet_id: "p-ming",
    name: "明代·孙悟空",
    dating: "明代·约1580年",
    parts: [
      { part_id: "m-head", name: "头部" },
      { part_id: "m-arm", name: "右臂" },
    ],
  });
  registerPuppet(app, conservator, {
    puppet_id: "r-ming",
    name: "孙悟空复制件",
    artifact_class: "replica",
    dating: "2023年复制",
    parts: [{ part_id: "r-head", name: "头部复制件" }],
  });
  app.send(
    {
      aggregate: "puppet",
      type: "DeclareSubstitute",
      puppet_id: "p-ming",
      replica_puppet_id: "r-ming",
      covers_part_ids: [],
      approved_roles: [{ play_id: "naotiangong", role: "孙悟空" }],
    },
    { actor: conservator },
  );
  app.send(
    {
      aggregate: "puppet",
      type: "DeclarePlayableRole",
      puppet_id: "p-ming",
      play_id: "naotiangong",
      role: "孙悟空",
    },
    { actor: master },
  );

  // 2) 出库巡演（冻结部件的老件不能出库——这里先出库）
  app.send(
    {
      aggregate: "loan",
      type: "CheckoutLoan",
      loan_id: "loan-tour",
      puppet_id: "p-ming",
      custodian_id: "c-stagehand",
      purpose: "秋收巡演",
      expected_return_at: "2026-09-25T18:00:00+08:00",
    },
    { actor: manager, at: "2026-09-20T08:00:00+08:00" },
  );

  // 3) 9-21 场：环境合格、评估、显式授权后上台
  app.send(
    {
      aggregate: "environment",
      type: "RecordEnvironment",
      location: VENUE,
      temp_c: 24,
      humidity_pct: 68,
      puppet_ids_present: ["p-ming"],
    },
    { actor: manager, at: "2026-09-21T17:00:00+08:00" },
  );
  app.send(
    {
      aggregate: "plan",
      type: "PlanPerformance",
      plan_id: "plan-921",
      occasion: "village",
      title: "五里村秋戏",
      venue: VENUE,
      starts_at: SHOW,
      tickets_sold: true,
      items: [{ item_id: "i-1", play_id: "naotiangong", role: "孙悟空", puppet_id: "p-ming" }],
    },
    { actor: manager },
  );
  app.send(
    { aggregate: "plan", type: "EvaluateClearance", plan_id: "plan-921", item_id: "i-1" },
    { actor: manager },
  );
  app.send(
    { aggregate: "plan", type: "AuthorizeStageUse", plan_id: "plan-921", item_id: "i-1" },
    { actor: lead },
  );

  // 4) 转场到高湿地带，9-22 临场发现右臂虫蛀——只冻结右臂
  app.send(
    {
      aggregate: "environment",
      type: "RecordEnvironment",
      location: VENUE,
      temp_c: 27,
      humidity_pct: 78,
      puppet_ids_present: ["p-ming"],
    },
    { actor: manager, at: "2026-09-22T16:00:00+08:00" },
  );
  app.send(
    {
      aggregate: "puppet",
      type: "ObserveDamage",
      puppet_id: "p-ming",
      part_id: "m-arm",
      damage_kind: "worm",
      severity: 2,
      description: "右臂内侧虫蛀通道，伴高湿返潮",
      part_only: true,
    },
    { actor: conservator, at: "2026-09-22T16:30:00+08:00" },
  );

  // 5) 晚场排期：老件被冻结部件+高湿双重否决，建议替身；指派替身后换场成功
  app.send(
    {
      aggregate: "plan",
      type: "PlanPerformance",
      plan_id: "plan-922",
      occasion: "village",
      title: "五里村夜戏",
      venue: VENUE,
      starts_at: "2026-09-22T19:30:00+08:00",
      tickets_sold: true,
      items: [{ item_id: "j-1", play_id: "naotiangong", role: "孙悟空", puppet_id: "p-ming" }],
    },
    { actor: manager },
  );
  app.send(
    { aggregate: "plan", type: "EvaluateClearance", plan_id: "plan-922", item_id: "j-1" },
    { actor: manager },
  );
  const blocked = buildStageBoard(app.store).find((b) => b.plan_id === "plan-922").items[0];
  assert.equal(blocked.latest_decision, "blocked");
  assert.ok(blocked.block_reasons.some((r) => r.includes("虫蛀") || r.includes("冻结")));
  assert.ok(blocked.block_reasons.some((r) => r.includes("高湿")));
  assert.equal(blocked.suggested_replica_puppet_id, "r-ming");

  app.send(
    {
      aggregate: "plan",
      type: "AssignSubstitute",
      plan_id: "plan-922",
      item_id: "j-1",
      replica_puppet_id: "r-ming",
    },
    { actor: manager },
  );
  // 替身需出库才能到场——复制件另开借用，不受老件冻结影响
  app.send(
    {
      aggregate: "loan",
      type: "CheckoutLoan",
      loan_id: "loan-rep",
      puppet_id: "r-ming",
      custodian_id: "c-stagehand",
      purpose: "顶替夜戏",
    },
    { actor: manager },
  );
  app.send(
    { aggregate: "plan", type: "EvaluateClearance", plan_id: "plan-922", item_id: "j-1" },
    { actor: manager },
  );
  app.send(
    { aggregate: "plan", type: "AuthorizeStageUse", plan_id: "plan-922", item_id: "j-1" },
    { actor: lead },
  );
  const go = buildStageBoard(app.store).find((b) => b.plan_id === "plan-922").items[0];
  assert.equal(go.effective_puppet_id, "r-ming");
  assert.equal(go.status, "substituted");

  // 6) 修缮师从虫蛀追到最近使用与此前环境
  const trace = buildConservationTrace(app.store).find((t) => t.puppet_id === "p-ming");
  const arm = trace.parts.find((p) => p.part_id === "m-arm");
  assert.equal(arm.status, "frozen");
  const worm = arm.damages.find((d) => d.kind === "worm");
  assert.equal(worm.nearest_prior_use.plan_id, "plan-921");
  assert.equal(worm.nearest_prior_use.venue, VENUE);
  assert.ok(worm.environment_before.length >= 1);
  // 最近的环境信号是 9-21 17:00 合格读数之后、9-22 16:00 的高湿读数
  const latestEnv = worm.environment_before[0];
  assert.equal(latestEnv.humidity_pct, 78);
  // 头部未被冻结
  assert.equal(trace.parts.find((p) => p.part_id === "m-head").status, "ok");

  // 7) 学徒名册真实能力：只有通过复核的能力才 independent
  app.send(
    { aggregate: "apprentice", type: "EnrollApprentice", apprentice_id: "a-1", name: "小周", minor: false },
    { actor: master },
  );
  for (const [layer, stage] of [[1, "trainee"], [2, "supervised"]]) {
    app.send(
      {
        aggregate: "apprentice",
        type: "RecordTrainingLevel",
        apprentice_id: "a-1",
        competency: "manipulation",
        stage,
        layer,
      },
      { actor: master },
    );
  }
  app.send(
    { aggregate: "apprentice", type: "PassMasterReview", apprentice_id: "a-1", competency: "manipulation" },
    { actor: master },
  );
  const roster = buildCompetencyRoster(app.store).find((r) => r.apprentice_id === "a-1");
  assert.equal(roster.competencies.find((c) => c.label === "独立操控").independent, true);
  assert.equal(roster.competencies.find((c) => c.label === "独立制作").independent, false);
  assert.equal(roster.competencies.find((c) => c.label === "独立修补").independent, false);

  // 8) 当前位置唯一：老件在 c-stagehand，替身也在 c-stagehand（两条独立借用）
  const custody = Object.fromEntries(buildCustodyMap(app.store).map((x) => [x.puppet_id, x]));
  assert.equal(custody["p-ming"].status, "checked_out");
  assert.equal(custody["p-ming"].current_custodian_id, "c-stagehand");
  assert.equal(custody["r-ming"].current_custodian_id, "c-stagehand");
  assert.notEqual(custody["p-ming"].loan_id, custody["r-ming"].loan_id);
});
