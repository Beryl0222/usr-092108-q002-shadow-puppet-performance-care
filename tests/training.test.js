import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/errors.js";
import { TRAINING_LEVELS } from "../src/policy.js";
import { IDS, newApp, seedApprentices, qualify } from "./helpers.js";

test("训练必须逐级推进，跳级被拒绝", () => {
  const app = newApp();
  seedApprentices(app);
  assert.throws(
    () => app.training.logTraining({
      apprentice_id: IDS.apprenticeAdult, discipline: "操控",
      level: "独立操控", logged_by: IDS.master,
    }),
    (e) => e instanceof DomainError && e.code === "LEVEL_LOCKED"
  );
});

test("未经训练登记不能复核；只有本门师傅能复核", () => {
  const app = newApp();
  seedApprentices(app);
  assert.throws(
    () => app.training.review({
      apprentice_id: IDS.apprenticeAdult, discipline: "操控",
      level: "观摩", reviewer_id: IDS.master, passed: true,
    }),
    (e) => e instanceof DomainError && e.code === "TRAINING_NOT_LOGGED"
  );
  app.training.logTraining({
    apprentice_id: IDS.apprenticeAdult, discipline: "操控", level: "观摩", logged_by: IDS.master,
  });
  assert.throws(
    () => app.training.review({
      apprentice_id: IDS.apprenticeAdult, discipline: "操控",
      level: "观摩", reviewer_id: "外人-某", passed: true,
    }),
    (e) => e instanceof DomainError && e.code === "NOT_MASTER"
  );
});

test("复核未通过不能进入下一层级", () => {
  const app = newApp();
  seedApprentices(app);
  app.training.logTraining({
    apprentice_id: IDS.apprenticeAdult, discipline: "操控", level: "观摩", logged_by: IDS.master,
  });
  app.training.review({
    apprentice_id: IDS.apprenticeAdult, discipline: "操控",
    level: "观摩", reviewer_id: IDS.master, passed: false,
  });
  assert.throws(
    () => app.training.logTraining({
      apprentice_id: IDS.apprenticeAdult, discipline: "操控",
      level: "把杆辅助", logged_by: IDS.master,
    }),
    (e) => e instanceof DomainError && e.code === "LEVEL_LOCKED"
  );
});

test("层级未满不授予独立资格；逐级通过后取得真实资格", () => {
  const app = newApp();
  seedApprentices(app);
  // 只完成前两层
  app.training.logTraining({ apprentice_id: IDS.apprenticeAdult, discipline: "操控", level: "观摩", logged_by: IDS.master });
  app.training.review({ apprentice_id: IDS.apprenticeAdult, discipline: "操控", level: "观摩", reviewer_id: IDS.master, passed: true });
  assert.throws(
    () => app.training.grantQualification({
      apprentice_id: IDS.apprenticeAdult, discipline: "操控", granted_by: IDS.master,
    }),
    (e) => e instanceof DomainError && e.code === "STEPS_INCOMPLETE"
  );

  qualify(app, IDS.apprenticeAdult, "操控");
  const report = app.masterApprenticeReport().find((a) => a.apprentice_id === IDS.apprenticeAdult);
  assert.equal(report.can_manipulate_independently, true);
  assert.equal(report.can_make_independently, false);
  assert.equal(report.can_repair_independently, false);
});

test("未成年学徒在涉真品层级被封顶：操控科最高到复制品独立", () => {
  const app = newApp();
  seedApprentices(app);
  for (const level of ["观摩", "把杆辅助", "复制品独立"]) {
    app.training.logTraining({ apprentice_id: IDS.apprenticeMinor, discipline: "操控", level, logged_by: IDS.master });
    app.training.review({ apprentice_id: IDS.apprenticeMinor, discipline: "操控", level, reviewer_id: IDS.master, passed: true });
  }
  // 再往上是“真品协演”，需接触真品 → 拒绝
  assert.throws(
    () => app.training.logTraining({
      apprentice_id: IDS.apprenticeMinor, discipline: "操控",
      level: "真品协演", logged_by: IDS.master,
    }),
    (e) => e instanceof DomainError && e.code === "MINOR_LEVEL_FORBIDDEN"
  );
  // 因而无法取得独立操控资格
  assert.throws(
    () => app.training.grantQualification({
      apprentice_id: IDS.apprenticeMinor, discipline: "操控", granted_by: IDS.master,
    }),
    (e) => e instanceof DomainError && e.code === "STEPS_INCOMPLETE"
  );
  assert.equal(app.training.handlingLevel(IDS.apprenticeMinor), "仅复制品");
});

test("未成年学徒可在制作科取得独立资格（制作新件不涉真品），但接触级别仍封顶", () => {
  const app = newApp();
  seedApprentices(app);
  qualify(app, IDS.apprenticeMinor, "制作");
  const report = app.masterApprenticeReport().find((a) => a.apprentice_id === IDS.apprenticeMinor);
  assert.equal(report.can_make_independently, true);
  assert.equal(report.can_manipulate_independently, false);
  assert.equal(report.handling_level, "仅复制品");
});

test("成年学徒取得操控资格后可接触二级文物；一级文物仍须师傅在场", () => {
  const app = newApp();
  seedApprentices(app);
  qualify(app, IDS.apprenticeAdult, "操控");
  assert.equal(app.training.handlingLevel(IDS.apprenticeAdult), "二级文物");
  assert.doesNotThrow(() =>
    app.training.assertMayHandle({ person_id: IDS.apprenticeAdult, grade: "二级文物" })
  );
  assert.throws(
    () => app.training.assertMayHandle({ person_id: IDS.apprenticeAdult, grade: "一级文物", masterPresent: false }),
    (e) => e instanceof DomainError && e.code === "MASTER_REQUIRED"
  );
  assert.doesNotThrow(() =>
    app.training.assertMayHandle({ person_id: IDS.apprenticeAdult, grade: "一级文物", masterPresent: true })
  );
});

test("能力名册逐科如实呈现层级与复核状态", () => {
  const app = newApp();
  seedApprentices(app);
  const ladder = TRAINING_LEVELS["制作"];
  app.training.logTraining({ apprentice_id: IDS.apprenticeAdult, discipline: "制作", level: ladder[0], logged_by: IDS.master });
  app.training.review({ apprentice_id: IDS.apprenticeAdult, discipline: "制作", level: ladder[0], reviewer_id: IDS.master, passed: true });
  const report = app.masterApprenticeReport().find((a) => a.apprentice_id === IDS.apprenticeAdult);
  const making = report.disciplines.find((d) => d.discipline === "制作");
  assert.equal(making.highest_reviewed_level, ladder[0]);
  assert.equal(making.steps[0].passed, true);
  assert.equal(making.steps[1].logged, false);
  assert.equal(making.independent_qualified, false);
});
