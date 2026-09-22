import assert from "node:assert/strict";
import test from "node:test";

import { buildConservationTrace } from "../src/readModels.js";
import { ACTORS, newApp, registerPuppet, assertRejects } from "./helpers.js";

const { lead, conservator, manager, master } = ACTORS;

test("登记：老件与部件登记，角色越权被拒", () => {
  const app = newApp();
  registerPuppet(app, conservator, {
    puppet_id: "p-001",
    name: "明代·关公像",
    dating: "明代·约1600年",
    parts: [
      { part_id: "p-001-head", name: "头部" },
      { part_id: "p-001-arm-l", name: "左臂" },
    ],
  });
  const trace = buildConservationTrace(app.store).find((t) => t.puppet_id === "p-001");
  assert.equal(trace.artifact_class, "antique");
  assert.equal(trace.parts.length, 2);

  assertRejects(
    () =>
      app.send(
        { aggregate: "puppet", type: "RegisterPuppet", puppet_id: "p-x", name: "x", artifact_class: "antique", dating: "?" },
        { actor: manager },
      ),
    "FORBIDDEN",
  );
});

test("损伤：只冻结相关部件，其他部件仍可用", () => {
  const app = newApp();
  registerPuppet(app, conservator, {
    puppet_id: "p-001",
    name: "关公像",
    dating: "明代",
    parts: [
      { part_id: "h", name: "头部" },
      { part_id: "a", name: "左臂" },
      { part_id: "b", name: "右臂" },
    ],
  });
  app.send(
    {
      aggregate: "puppet",
      type: "ObserveDamage",
      puppet_id: "p-001",
      part_id: "a",
      damage_kind: "crack",
      severity: 2,
      description: "左臂关节处出现纵向裂纹",
      part_only: true,
    },
    { actor: conservator },
  );
  const trace = buildConservationTrace(app.store).find((t) => t.puppet_id === "p-001");
  const byId = Object.fromEntries(trace.parts.map((p) => [p.part_id, p]));
  assert.equal(byId.a.status, "frozen");
  assert.equal(byId.h.status, "ok");
  assert.equal(byId.b.status, "ok");
  assert.equal(byId.a.damages[0].kind, "crack");
});

test("结构性断裂（part_only=false）冻结整偶全部部件", () => {
  const app = newApp();
  registerPuppet(app, conservator, {
    puppet_id: "p-002",
    name: "娘娘像",
    dating: "清代",
    parts: [
      { part_id: "h", name: "头部" },
      { part_id: "t", name: "躯干" },
    ],
  });
  app.send(
    {
      aggregate: "puppet",
      type: "ObserveDamage",
      puppet_id: "p-002",
      part_id: "t",
      damage_kind: "fracture",
      severity: 3,
      description: "躯干贯通断裂，整偶无法安全登场",
      part_only: false,
    },
    { actor: conservator },
  );
  const trace = buildConservationTrace(app.store).find((t) => t.puppet_id === "p-002");
  assert.ok(trace.parts.every((p) => p.status === "frozen"));
});

test("修复：分层追加，返工不覆盖旧痕迹；修复本身不解冻，检验后才恢复", () => {
  const app = newApp();
  registerPuppet(app, conservator, {
    puppet_id: "p-001",
    name: "关公像",
    dating: "明代",
    parts: [{ part_id: "a", name: "左臂" }],
  });
  app.send(
    {
      aggregate: "puppet",
      type: "ObserveDamage",
      puppet_id: "p-001",
      part_id: "a",
      damage_kind: "worm",
      severity: 2,
      description: "虫蛀",
      part_only: true,
    },
    { actor: conservator },
  );
  app.send(
    {
      aggregate: "puppet",
      type: "AddRepairLayer",
      puppet_id: "p-001",
      part_id: "a",
      materials: ["天然鱼鳔胶", "桑皮纸"],
      techniques: ["传统托裱", "手工补缀"],
      note: "第一次处理",
    },
    { actor: conservator },
  );
  // 学徒身份不得记录修复
  assertRejects(
    () =>
      app.send(
        {
          aggregate: "puppet",
          type: "AddRepairLayer",
          puppet_id: "p-001",
          part_id: "a",
          materials: ["胶"],
          techniques: ["补"],
        },
        { actor: ACTORS.apprentice },
      ),
    "FORBIDDEN",
  );
  // 返工再记一层
  app.send(
    {
      aggregate: "puppet",
      type: "AddRepairLayer",
      puppet_id: "p-001",
      part_id: "a",
      materials: ["矿物颜料"],
      techniques: ["随色做旧"],
      note: "补色与旧层协调，保留旧痕",
    },
    { actor: conservator },
  );

  let trace = buildConservationTrace(app.store).find((t) => t.puppet_id === "p-001");
  const part = trace.parts[0];
  assert.equal(part.status, "frozen", "修复后仍冻结");
  assert.deepEqual(part.repair_layers.map((l) => l.layer_no), [1, 2]);
  assert.deepEqual(part.repair_layers[0].materials, ["天然鱼鳔胶", "桑皮纸"]);
  assert.deepEqual(part.repair_layers[1].techniques, ["随色做旧"]);

  // 缺材料/手法不允许
  assertRejects(
    () =>
      app.send(
        { aggregate: "puppet", type: "AddRepairLayer", puppet_id: "p-001", part_id: "a", materials: [], techniques: ["x"] },
        { actor: conservator },
      ),
    "BAD_INPUT",
  );

  // 检验后恢复
  app.send(
    {
      aggregate: "puppet",
      type: "InspectAndReturn",
      puppet_id: "p-001",
      part_id: "a",
      condition_note: "胶合牢固，虫蛀已稳定",
      resulting_status: "ok",
    },
    { actor: conservator },
  );
  trace = buildConservationTrace(app.store).find((t) => t.puppet_id === "p-001");
  assert.equal(trace.parts[0].status, "ok");
  assert.equal(trace.parts[0].repair_layers.length, 2, "两层修复记录都保留");
});

test("替身：须为独立复制品、核准剧目角色，整偶/部件覆盖分别校验", () => {
  const app = newApp();
  registerPuppet(app, conservator, {
    puppet_id: "p-old",
    name: "老件",
    dating: "明代",
    parts: [
      { part_id: "oh", name: "头部" },
      { part_id: "oa", name: "左臂" },
    ],
  });
  registerPuppet(app, conservator, {
    puppet_id: "r-new",
    name: "复制替身",
    artifact_class: "replica",
    dating: "2024年复制",
    parts: [{ part_id: "rh", name: "头部复制件" }],
  });

  // 不能为复制品登记替身
  assertRejects(
    () =>
      app.send(
        {
          aggregate: "puppet",
          type: "DeclareSubstitute",
          puppet_id: "r-new",
          replica_puppet_id: "x",
          covers_part_ids: [],
          approved_roles: [{ play_id: "play-a", role: "主角" }],
        },
        { actor: conservator },
      ),
    "BAD_INPUT",
  );

  app.send(
    {
      aggregate: "puppet",
      type: "DeclareSubstitute",
      puppet_id: "p-old",
      replica_puppet_id: "r-new",
      covers_part_ids: ["oh"],
      approved_roles: [
        { play_id: "play-a", role: "主角" },
        { play_id: "play-b", role: "配角" },
      ],
      replica_name: "复制替身",
    },
    { actor: conservator },
  );

  // 覆盖不存在的部件
  assertRejects(
    () =>
      app.send(
        {
          aggregate: "puppet",
          type: "DeclareSubstitute",
          puppet_id: "p-old",
          replica_puppet_id: "r-new",
          covers_part_ids: ["ghost"],
          approved_roles: [{ play_id: "play-c", role: "主角" }],
        },
        { actor: conservator },
      ),
    "NOT_FOUND",
  );

  const trace = buildConservationTrace(app.store).find((t) => t.puppet_id === "p-old");
  assert.equal(trace.substitutes[0].approved_roles.length, 2);
  assert.ok(lead);
  assert.ok(master);
});
