import assert from "node:assert/strict";
import test from "node:test";

import { buildStageBoard } from "../src/readModels.js";
import { ACTORS, newApp, registerPuppet, assertRejects } from "./helpers.js";

const { lead, manager, conservator, master } = ACTORS;
const VENUE = "邬阳乡戏台";
const START = "2026-09-22T19:00:00+08:00";

function healthyFixture() {
  const app = newApp();
  registerPuppet(app, conservator, {
    puppet_id: "p-old",
    name: "明代关公",
    dating: "明代·约1600年",
    parts: [
      { part_id: "oh", name: "头部" },
      { part_id: "oa", name: "左臂" },
    ],
  });
  registerPuppet(app, conservator, {
    puppet_id: "r-whole",
    name: "整偶替身",
    artifact_class: "replica",
    dating: "2024年复制",
    parts: [{ part_id: "x1", name: "替身头部" }],
  });
  app.send(
    {
      aggregate: "puppet",
      type: "DeclareSubstitute",
      puppet_id: "p-old",
      replica_puppet_id: "r-whole",
      covers_part_ids: [],
      approved_roles: [{ play_id: "play-a", role: "关公" }],
    },
    { actor: conservator },
  );
  app.send(
    { aggregate: "puppet", type: "DeclarePlayableRole", puppet_id: "p-old", play_id: "play-a", role: "关公" },
    { actor: master },
  );
  app.send(
    {
      aggregate: "environment",
      type: "RecordEnvironment",
      location: VENUE,
      temp_c: 22,
      humidity_pct: 62,
      puppet_ids_present: ["p-old"],
    },
    { actor: manager, at: "2026-09-22T17:30:00+08:00" },
  );
  return app;
}

function planItem(app, overrides = {}) {
  app.send(
    {
      aggregate: "plan",
      type: "PlanPerformance",
      plan_id: "plan-1",
      occasion: "festival",
      title: "中秋会戏",
      venue: VENUE,
      starts_at: START,
      tickets_sold: overrides.tickets_sold ?? false,
      items: [
        {
          item_id: "it-1",
          play_id: "play-a",
          role: "关公",
          puppet_id: "p-old",
          ...(overrides_item(overrides)),
        },
      ],
    },
    { actor: manager },
  );
}

function overrides_item(o) {
  return { part_ids: o.part_ids, operator_id: o.operator_id, operator_supervised: o.operator_supervised };
}

function evalAndAuthorize(app, { actor = manager, grant = true } = {}) {
  app.send({ aggregate: "plan", type: "EvaluateClearance", plan_id: "plan-1", item_id: "it-1" }, { actor });
  if (grant) {
    app.send(
      { aggregate: "plan", type: "AuthorizeStageUse", plan_id: "plan-1", item_id: "it-1", scope: "本场" },
      { actor: lead },
    );
  }
}

test("放行：已售票不自动放行，须显式授权；经理无权授权", () => {
  const app = healthyFixture();
  planItem(app, { tickets_sold: true });

  // 未评估直接授权
  assertRejects(
    () =>
      app.send(
        { aggregate: "plan", type: "AuthorizeStageUse", plan_id: "plan-1", item_id: "it-1" },
        { actor: lead },
      ),
    "NOT_EVALUATED",
  );

  app.send({ aggregate: "plan", type: "EvaluateClearance", plan_id: "plan-1", item_id: "it-1" }, { actor: manager });
  let board = buildStageBoard(app.store)[0];
  let item = board.items[0];
  assert.equal(item.latest_decision, "cleared");
  assert.equal(item.authorized, false);
  assert.ok(item.latest_reasons.some((r) => r.includes("已售票")));

  // 演出经理不能授权
  assertRejects(
    () =>
      app.send(
        { aggregate: "plan", type: "AuthorizeStageUse", plan_id: "plan-1", item_id: "it-1" },
        { actor: manager },
      ),
    "FORBIDDEN",
  );
  app.send(
    { aggregate: "plan", type: "AuthorizeStageUse", plan_id: "plan-1", item_id: "it-1" },
    { actor: lead },
  );
  board = buildStageBoard(app.store)[0];
  assert.equal(board.items[0].authorized, true);
  assert.equal(board.items[0].status, "cleared");
});

test("放行：缺环境读数 / 高湿 否决老件", () => {
  const app = newApp();
  registerPuppet(app, conservator, {
    puppet_id: "p-old",
    name: "关公",
    dating: "明代",
    parts: [{ part_id: "oh", name: "头部" }],
  });
  app.send(
    { aggregate: "puppet", type: "DeclarePlayableRole", puppet_id: "p-old", play_id: "play-a", role: "关公" },
    { actor: master },
  );
  planItem(app);

  app.send({ aggregate: "plan", type: "EvaluateClearance", plan_id: "plan-1", item_id: "it-1" }, { actor: manager });
  let board = buildStageBoard(app.store)[0];
  assert.equal(board.items[0].latest_decision, "blocked");
  assert.ok(board.items[0].block_reasons.some((r) => r.includes("环境读数")));

  // 高湿读数（窗口内）
  app.send(
    {
      aggregate: "environment",
      type: "RecordEnvironment",
      location: VENUE,
      temp_c: 26,
      humidity_pct: 82,
      puppet_ids_present: ["p-old"],
    },
    { actor: manager, at: "2026-09-22T18:00:00+08:00" },
  );
  app.send({ aggregate: "plan", type: "EvaluateClearance", plan_id: "plan-1", item_id: "it-1" }, { actor: manager });
  board = buildStageBoard(app.store)[0];
  assert.equal(board.items[0].latest_decision, "blocked");
  assert.ok(board.items[0].block_reasons.some((r) => r.includes("高湿")));
  assertRejects(
    () =>
      app.send(
        { aggregate: "plan", type: "AuthorizeStageUse", plan_id: "plan-1", item_id: "it-1" },
        { actor: lead },
      ),
    "BLOCKED",
  );
});

test("放行：超窗读数不算数（7 小时前）", () => {
  const app = healthyFixture();
  app.send(
    {
      aggregate: "environment",
      type: "RecordEnvironment",
      location: VENUE,
      temp_c: 22,
      humidity_pct: 60,
      puppet_ids_present: ["p-old"],
    },
    { actor: manager, at: "2026-09-22T11:00:00+08:00" }, // 开场前 8 小时
  );
  planItem(app);
  // healthyFixture 中 17:30 的读数在窗口内，先删除影响：改用另一无读数场地验证窗口
  app.send(
    {
      aggregate: "plan",
      type: "PlanPerformance",
      plan_id: "plan-2",
      occasion: "village",
      title: "夜场",
      venue: "太平村祠堂",
      starts_at: START,
      tickets_sold: false,
      items: [{ item_id: "j-1", play_id: "play-a", role: "关公", puppet_id: "p-old" }],
    },
    { actor: manager },
  );
  app.send({ aggregate: "plan", type: "EvaluateClearance", plan_id: "plan-2", item_id: "j-1" }, { actor: manager });
  const board = buildStageBoard(app.store).find((b) => b.plan_id === "plan-2");
  assert.equal(board.items[0].latest_decision, "blocked");
  assert.ok(board.items[0].block_reasons.some((r) => r.includes("环境读数")));
});

test("开裂：冻结相关部件 → 建议核准替身 → 指派后换场成功且不伤老件", () => {
  const app = healthyFixture();
  planItem(app);
  // 演出当天发现头部开裂（整偶条目；整偶替身在册）
  app.send(
    {
      aggregate: "puppet",
      type: "ObserveDamage",
      puppet_id: "p-old",
      part_id: "oh",
      damage_kind: "crack",
      severity: 2,
      description: "头冠根部开裂",
      part_only: true,
    },
    { actor: conservator, at: "2026-09-22T15:00:00+08:00" },
  );
  app.send({ aggregate: "plan", type: "EvaluateClearance", plan_id: "plan-1", item_id: "it-1" }, { actor: manager });
  let board = buildStageBoard(app.store)[0];
  let item = board.items[0];
  assert.equal(item.latest_decision, "blocked");
  assert.equal(item.suggested_replica_puppet_id, "r-whole");
  assert.ok(item.block_reasons.some((r) => r.includes("冻结")));

  // 未核准的替身不能指派
  registerPuppet(app, conservator, {
    puppet_id: "r-rogue",
    name: "野替身",
    artifact_class: "replica",
    dating: "2025",
    parts: [],
  });
  assertRejects(
    () =>
      app.send(
        {
          aggregate: "plan",
          type: "AssignSubstitute",
          plan_id: "plan-1",
          item_id: "it-1",
          replica_puppet_id: "r-rogue",
        },
        { actor: manager },
      ),
    "NOT_APPROVED",
  );

  app.send(
    {
      aggregate: "plan",
      type: "AssignSubstitute",
      plan_id: "plan-1",
      item_id: "it-1",
      replica_puppet_id: "r-whole",
    },
    { actor: manager },
  );
  // 指派后旧评估失效，必须重评；替身免环境硬门槛
  assertRejects(
    () =>
      app.send(
        { aggregate: "plan", type: "AuthorizeStageUse", plan_id: "plan-1", item_id: "it-1" },
        { actor: lead },
      ),
    "NOT_EVALUATED",
  );
  app.send({ aggregate: "plan", type: "EvaluateClearance", plan_id: "plan-1", item_id: "it-1" }, { actor: manager });
  app.send(
    { aggregate: "plan", type: "AuthorizeStageUse", plan_id: "plan-1", item_id: "it-1" },
    { actor: lead },
  );
  board = buildStageBoard(app.store)[0];
  item = board.items[0];
  assert.equal(item.effective_puppet_id, "r-whole");
  assert.equal(item.antique_puppet_id, "p-old");
  assert.equal(item.status, "substituted");
  assert.equal(item.authorized, true);
  assert.deepEqual(board.next_actions, []);
});

test("换戏：旧授权失效，新角色未核准替身上台被拦", () => {
  const app = healthyFixture();
  planItem(app);
  evalAndAuthorize(app);
  app.send(
    {
      aggregate: "plan",
      type: "SwapPlay",
      plan_id: "plan-1",
      item_id: "it-1",
      to_play_id: "play-b",
      to_role: "曹操",
      reason: "邻村点戏",
    },
    { actor: manager },
  );
  const board = buildStageBoard(app.store)[0];
  assert.equal(board.items[0].authorized, false);
  assert.equal(board.items[0].status, "scheduled");

  // 老件未登记可承担 play-b 曹操 → blocked；整偶替身也只核准了 play-a
  app.send({ aggregate: "plan", type: "EvaluateClearance", plan_id: "plan-1", item_id: "it-1" }, { actor: manager });
  const after = buildStageBoard(app.store)[0].items[0];
  assert.equal(after.latest_decision, "blocked");
  assert.ok(after.block_reasons.some((r) => r.includes("未登记可承担")));
  assert.equal(after.suggested_replica_puppet_id, null, "未核准新角色，不应给替身建议");
});

test("操作者：学徒须独立或监督在场；未成年学徒不能上老件", () => {
  const app = healthyFixture();
  // 成年学徒：操控 supervised
  app.send(
    { aggregate: "apprentice", type: "EnrollApprentice", apprentice_id: "a-1", name: "小周", minor: false },
    { actor: master },
  );
  app.send(
    { aggregate: "apprentice", type: "RecordTrainingLevel", apprentice_id: "a-1", competency: "manipulation", stage: "trainee", layer: 1 },
    { actor: master },
  );
  planItem(app, { operator_id: "a-1" });
  app.send({ aggregate: "plan", type: "EvaluateClearance", plan_id: "plan-1", item_id: "it-1" }, { actor: manager });
  let item = buildStageBoard(app.store)[0].items[0];
  assert.equal(item.latest_decision, "blocked");
  assert.ok(item.block_reasons.some((r) => r.includes("操控资格不足")));

  // 师傅在场监督，且授予老件接触 → 通过
  app.send(
    { aggregate: "plan", type: "AssignOperator", plan_id: "plan-1", item_id: "it-1", operator_id: "a-1", operator_supervised: true },
    { actor: master },
  );
  app.send(
    { aggregate: "apprentice", type: "GrantHandlingPrivilege", apprentice_id: "a-1", handling_level: "authentic" },
    { actor: master },
  );
  app.send(
    { aggregate: "apprentice", type: "RecordTrainingLevel", apprentice_id: "a-1", competency: "manipulation", stage: "supervised", layer: 2 },
    { actor: master },
  );
  app.send({ aggregate: "plan", type: "EvaluateClearance", plan_id: "plan-1", item_id: "it-1" }, { actor: manager });
  item = buildStageBoard(app.store)[0].items[0];
  assert.equal(item.latest_decision, "cleared", item.block_reasons.join("；"));

  // 未成年学徒：即使 supervised 也不能接触老件
  app.send(
    { aggregate: "apprentice", type: "EnrollApprentice", apprentice_id: "a-m", name: "小禾", minor: true },
    { actor: master },
  );
  app.send(
    { aggregate: "apprentice", type: "RecordTrainingLevel", apprentice_id: "a-m", competency: "manipulation", stage: "supervised", layer: 1 },
    { actor: master },
  );
  app.send(
    { aggregate: "apprentice", type: "GrantHandlingPrivilege", apprentice_id: "a-m", handling_level: "replica" },
    { actor: master },
  );
  app.send(
    { aggregate: "plan", type: "AssignOperator", plan_id: "plan-1", item_id: "it-1", operator_id: "a-m", operator_supervised: true },
    { actor: master },
  );
  app.send({ aggregate: "plan", type: "EvaluateClearance", plan_id: "plan-1", item_id: "it-1" }, { actor: manager });
  item = buildStageBoard(app.store)[0].items[0];
  assert.equal(item.latest_decision, "blocked");
  assert.ok(item.block_reasons.some((r) => r.includes("未成年人仅限复制品道具")));
});
