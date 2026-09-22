import assert from "node:assert/strict";
import test from "node:test";

import { buildCompetencyRoster } from "../src/readModels.js";
import { ACTORS, newApp, assertRejects } from "./helpers.js";

const { master, lead, manager, conservator } = ACTORS;

test("学徒：分层训练不能跳级，训练记录不授独立，须师傅复核", () => {
  const app = newApp();
  app.send(
    { aggregate: "apprentice", type: "EnrollApprentice", apprentice_id: "a-1", name: "小周", minor: false },
    { actor: master },
  );

  // 跳层
  assertRejects(
    () =>
      app.send(
        {
          aggregate: "apprentice",
          type: "RecordTrainingLevel",
          apprentice_id: "a-1",
          competency: "manipulation",
          stage: "trainee",
          layer: 3,
        },
        { actor: master },
      ),
    "LAYER_SKIPPED",
  );

  // 非传承人不能记训练
  assertRejects(
    () =>
      app.send(
        {
          aggregate: "apprentice",
          type: "RecordTrainingLevel",
          apprentice_id: "a-1",
          competency: "manipulation",
          stage: "trainee",
          layer: 1,
        },
        { actor: manager },
      ),
    "FORBIDDEN",
  );

  app.send(
    {
      aggregate: "apprentice",
      type: "RecordTrainingLevel",
      apprentice_id: "a-1",
      competency: "manipulation",
      stage: "trainee",
      layer: 1,
      note: "握扦基础",
    },
    { actor: master },
  );
  app.send(
    {
      aggregate: "apprentice",
      type: "RecordTrainingLevel",
      apprentice_id: "a-1",
      competency: "manipulation",
      stage: "supervised",
      layer: 2,
      note: "监督下完整折子",
    },
    { actor: master },
  );

  // 训练记录不能直接记 independent
  assertRejects(
    () =>
      app.send(
        {
          aggregate: "apprentice",
          type: "RecordTrainingLevel",
          apprentice_id: "a-1",
          competency: "crafting",
          stage: "independent",
          layer: 1,
        },
        { actor: master },
      ),
    "REVIEW_REQUIRED",
  );
  // 未到 supervised 不能复核
  assertRejects(
    () =>
      app.send(
        { aggregate: "apprentice", type: "PassMasterReview", apprentice_id: "a-1", competency: "crafting" },
        { actor: master },
      ),
    "NOT_READY",
  );

  // 复核前名册：操控尚非独立
  let roster = buildCompetencyRoster(app.store);
  let a1 = roster.find((r) => r.apprentice_id === "a-1");
  assert.equal(a1.competencies.find((c) => c.competency === "manipulation").independent, false);

  app.send(
    { aggregate: "apprentice", type: "PassMasterReview", apprentice_id: "a-1", competency: "manipulation", note: "可独立担纲" },
    { actor: master },
  );

  roster = buildCompetencyRoster(app.store);
  a1 = roster.find((r) => r.apprentice_id === "a-1");
  const manip = a1.competencies.find((c) => c.competency === "manipulation");
  assert.equal(manip.independent, true);
  assert.equal(manip.stage, "independent");
  assert.equal(manip.master_review.reviewer_id, master.id);
  assert.equal(a1.competencies.find((c) => c.competency === "repair").stage, "none");
});

test("学徒：未成年人不得获老件授权，只能 replica；成年学徒可获 authentic", () => {
  const app = newApp();
  app.send(
    { aggregate: "apprentice", type: "EnrollApprentice", apprentice_id: "a-minor", name: "小禾", minor: true },
    { actor: master },
  );
  app.send(
    { aggregate: "apprentice", type: "EnrollApprentice", apprentice_id: "a-adult", name: "小秦", minor: false },
    { actor: master },
  );

  assertRejects(
    () =>
      app.send(
        {
          aggregate: "apprentice",
          type: "GrantHandlingPrivilege",
          apprentice_id: "a-minor",
          handling_level: "authentic",
        },
        { actor: master },
      ),
    "MINOR_FORBIDDEN",
  );

  app.send(
    {
      aggregate: "apprentice",
      type: "GrantHandlingPrivilege",
      apprentice_id: "a-minor",
      handling_level: "replica",
    },
    { actor: master },
  );
  // 修缮师不能授予接触级别
  assertRejects(
    () =>
      app.send(
        {
          aggregate: "apprentice",
          type: "GrantHandlingPrivilege",
          apprentice_id: "a-adult",
          handling_level: "authentic",
        },
        { actor: conservator },
      ),
    "FORBIDDEN",
  );
  app.send(
    {
      aggregate: "apprentice",
      type: "GrantHandlingPrivilege",
      apprentice_id: "a-adult",
      handling_level: "authentic",
    },
    { actor: master },
  );

  const roster = buildCompetencyRoster(app.store);
  const minor = roster.find((r) => r.apprentice_id === "a-minor");
  const adult = roster.find((r) => r.apprentice_id === "a-adult");
  assert.equal(minor.handling_level, "replica");
  assert.equal(minor.may_touch_antique, false);
  assert.equal(adult.may_touch_antique, true);
  assert.ok(lead);
});
