import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/errors.js";
import { IDS, newApp, seedObjects, seedShow, safeReading, humidReading, seedApprentices, qualify } from "./helpers.js";

function castOld(app, operator = IDS.artist) {
  app.performances.castRole({
    performance_id: "PF-中秋场",
    role_id: "ROLE-老旦",
    role_name: "老旦",
    object_id: IDS.old,
    operator_id: operator,
  });
}

test("三因子齐全且持有一级文物特批才放行；售票本身不构成授权", () => {
  const app = newApp();
  seedObjects(app);
  seedShow(app, { ticket_sold: true });
  castOld(app);
  safeReading(app);

  // 第一次：无特批 —— 一级文物默认不上台，即使票已售出
  app.performances.requestClearance({
    performance_id: "PF-中秋场", role_id: "ROLE-老旦",
    reading_id: "ENV-安全", requested_by: IDS.manager,
  });
  app.performances.decideClearance({ performance_id: "PF-中秋场", role_id: "ROLE-老旦", decided_by: IDS.restorer });
  let role = app.view.performances.get("PF-中秋场").roles.get("ROLE-老旦");
  assert.equal(role.latest_clearance.granted, false);
  assert.match(role.latest_clearance.reasons.join("；"), /书面特批/);

  // 第二次：特批 + 安全环境 + 有资质艺人 —— 放行
  app.performances.requestClearance({
    performance_id: "PF-中秋场", role_id: "ROLE-老旦",
    reading_id: "ENV-安全", requested_by: IDS.manager,
  });
  app.performances.decideClearance({
    performance_id: "PF-中秋场", role_id: "ROLE-老旦", decided_by: IDS.restorer,
    special_approval: {
      reference: "鹤文旅〔2026〕特批07号",
      approver: "文物主管部门-郑",
      reason: "中秋乡村节庆一次性亮相，温湿度受控、专人盯场",
    },
    master_present: true,
  });
  role = app.view.performances.get("PF-中秋场").roles.get("ROLE-老旦");
  assert.equal(role.latest_clearance.granted, true);
});

test("高湿环境一票否决，特批也不能覆盖环境因子", () => {
  const app = newApp();
  seedObjects(app);
  seedShow(app);
  castOld(app);
  humidReading(app);
  app.performances.requestClearance({
    performance_id: "PF-中秋场", role_id: "ROLE-老旦",
    reading_id: "ENV-高湿", requested_by: IDS.manager,
  });
  app.performances.decideClearance({
    performance_id: "PF-中秋场", role_id: "ROLE-老旦", decided_by: IDS.restorer,
    special_approval: { reference: "x", approver: "y", reason: "售票压力" },
  });
  const role = app.view.performances.get("PF-中秋场").roles.get("ROLE-老旦");
  assert.equal(role.latest_clearance.granted, false);
  assert.match(role.latest_clearance.reasons.join("；"), /相对湿度/);
});

test("部件冻结一票否决，且特批不能覆盖保存状态", () => {
  const app = newApp();
  seedObjects(app);
  seedShow(app);
  castOld(app);
  safeReading(app);
  app.inventory.reportDamage({
    object_id: IDS.old, reporter_id: "r",
    findings: [{ part_id: "P-右臂", condition: "开裂" }],
  });
  const verdict = app.performances.evaluate({
    performance: app.view.performances.get("PF-中秋场"),
    role: app.view.performances.get("PF-中秋场").roles.get("ROLE-老旦"),
    object_id: IDS.old,
    operator_id: IDS.artist,
    part_ids: null,
    reading: app.view.environmentReadings.get("ENV-安全"),
    special_approval: { reference: "x", approver: "y", reason: "z" },
    master_present: true,
  });
  assert.equal(verdict.can_go_ahead, false);
  assert.match(verdict.reasons.join("；"), /部件冻结/);
});

test("临时换戏：老件部件冻结时自动改派核准复制品，换角后旧许可失效需重核", () => {
  const app = newApp();
  seedObjects(app);
  seedShow(app);
  castOld(app);
  safeReading(app);
  app.performances.requestClearance({
    performance_id: "PF-中秋场", role_id: "ROLE-老旦",
    reading_id: "ENV-安全", requested_by: IDS.manager,
  });
  app.performances.decideClearance({
    performance_id: "PF-中秋场", role_id: "ROLE-老旦", decided_by: IDS.restorer,
    special_approval: { reference: "文号1", approver: "郑", reason: "受控亮相" },
    master_present: true,
  });

  app.inventory.reportDamage({
    object_id: IDS.old, reporter_id: "r",
    findings: [{ part_id: "P-右臂", condition: "开裂" }],
  });
  const r = app.performances.substituteRole({
    performance_id: "PF-中秋场", role_id: "ROLE-老旦", decided_by: IDS.manager,
  });
  assert.equal(r.to_object_id, IDS.replica);

  const role = app.view.performances.get("PF-中秋场").roles.get("ROLE-老旦");
  assert.equal(role.latest_clearance, null, "换角后旧许可不得沿用至复制品之外的判断");

  // 复制品无等级门槛，重新核验即放行
  app.performances.requestClearance({
    performance_id: "PF-中秋场", role_id: "ROLE-老旦",
    reading_id: "ENV-安全", requested_by: IDS.manager,
  });
  app.performances.decideClearance({ performance_id: "PF-中秋场", role_id: "ROLE-老旦", decided_by: IDS.restorer });
  assert.equal(app.view.performances.get("PF-中秋场").roles.get("ROLE-老旦").latest_clearance.granted, true);
});

test("无核准替身时拒绝换角，不能带伤硬演", () => {
  const app = newApp();
  seedObjects(app);
  seedShow(app);
  castOld(app);
  safeReading(app);
  app.inventory.reportDamage({
    object_id: IDS.old, reporter_id: "r",
    findings: [{ part_id: "P-右臂", condition: "开裂" }],
  });
  // 替身不能演这出戏 → 无候选
  app.inventory.setRepertoire({ object_id: IDS.replica, plays: ["另一出戏"], updated_by: IDS.master });
  assert.throws(
    () => app.performances.substituteRole({ performance_id: "PF-中秋场", role_id: "ROLE-老旦", decided_by: IDS.manager }),
    (e) => e instanceof DomainError && e.code === "NO_APPROVED_SUBSTITUTE"
  );
});

test("老件未冻结时不允许仅凭售票压力发起替角", () => {
  const app = newApp();
  seedObjects(app);
  seedShow(app);
  castOld(app);
  assert.throws(
    () => app.performances.substituteRole({ performance_id: "PF-中秋场", role_id: "ROLE-老旦", decided_by: IDS.manager }),
    (e) => e instanceof DomainError && e.code === "SUBSTITUTION_UNNECESSARY"
  );
});

test("未成年学徒不得派演真品；派演复制品放行", () => {
  const app = newApp();
  seedObjects(app);
  seedApprentices(app);
  seedShow(app);
  assert.throws(
    () => castOld(app, IDS.apprenticeMinor),
    (e) => e instanceof DomainError && e.code === "HANDLING_FORBIDDEN"
  );
  assert.doesNotThrow(() =>
    app.performances.castRole({
      performance_id: "PF-中秋场", role_id: "ROLE-小旦", role_name: "小旦",
      object_id: IDS.replica, operator_id: IDS.apprenticeMinor,
    })
  );
});

test("超出可用剧目清单的影偶不能派演", () => {
  const app = newApp();
  seedObjects(app);
  seedShow(app); // 《鹤峰记》
  app.inventory.setRepertoire({ object_id: IDS.old, plays: ["只演碧潭会"], updated_by: IDS.master });
  assert.throws(
    () => castOld(app),
    (e) => e instanceof DomainError && e.code === "NOT_IN_REPERTOIRE"
  );
});

test("开演前复检汇总三因子并确认许可与当前派戏一致", () => {
  const app = newApp();
  seedObjects(app);
  seedShow(app);
  castOld(app);
  humidReading(app, "ENV-临场");
  const check = app.performances.preShowCheck("PF-中秋场", "ENV-临场");
  assert.equal(check.can_go_ahead, false);
  assert.match(check.roles[0].reasons.join("；"), /相对湿度|特批/);
});
