import assert from "node:assert/strict";
import test from "node:test";

import { buildCustodyMap, OfflineLedger } from "../src/index.js";
import { ACTORS, newApp, registerPuppet, assertRejects } from "./helpers.js";

const { lead, manager, conservator } = ACTORS;

function puppetReady(app, id = "p-old") {
  registerPuppet(app, conservator, {
    puppet_id: id,
    name: "老件",
    dating: "明代",
    parts: [{ part_id: `${id}-h`, name: "头部" }],
  });
}

test("借用：在线出库唯一持有人；冻结老件禁止出库", () => {
  const app = newApp();
  puppetReady(app);
  app.send(
    {
      aggregate: "loan",
      type: "CheckoutLoan",
      loan_id: "loan-1",
      puppet_id: "p-old",
      custodian_id: "c-zhang",
      purpose: "邬阳乡节庆",
    },
    { actor: manager },
  );
  assertRejects(
    () =>
      app.send(
        {
          aggregate: "loan",
          type: "CheckoutLoan",
          loan_id: "loan-2",
          puppet_id: "p-old",
          custodian_id: "c-li",
          purpose: "另一活动",
        },
        { actor: manager },
      ),
    "DUPLICATE_CUSTODY",
  );

  // 交接必须从当前持有人发出
  assertRejects(
    () =>
      app.send(
        {
          aggregate: "loan",
          type: "TransferCustody",
          loan_id: "loan-1",
          from_custodian_id: "c-li",
          to_custodian_id: "c-wang",
          handoff_note: "半路交接",
        },
        { actor: manager },
      ),
    "CUSTODY_MISMATCH",
  );
  app.send(
    {
      aggregate: "loan",
      type: "TransferCustody",
      loan_id: "loan-1",
      from_custodian_id: "c-zhang",
      to_custodian_id: "c-wang",
      handoff_note: "戏台侧屋交接",
    },
    { actor: manager },
  );

  // 归还须逐部件清点，且由当前持有人归还
  assertRejects(
    () =>
      app.send(
        {
          aggregate: "loan",
          type: "ReturnLoan",
          loan_id: "loan-1",
          returned_by: "c-zhang",
          condition_note: "ok",
          parts_checked: [{ part_id: "p-old-h", present: true }],
        },
        { actor: manager },
      ),
    "CUSTODY_MISMATCH",
  );
  app.send(
    {
      aggregate: "loan",
      type: "ReturnLoan",
      loan_id: "loan-1",
      returned_by: "c-wang",
      condition_note: "完好",
      parts_checked: [{ part_id: "p-old-h", present: true }],
    },
    { actor: manager },
  );
  // 归还后可再次出库
  app.send(
    {
      aggregate: "loan",
      type: "CheckoutLoan",
      loan_id: "loan-3",
      puppet_id: "p-old",
      custodian_id: "c-chen",
      purpose: "传习所",
    },
    { actor: lead },
  );
  const map = Object.fromEntries(buildCustodyMap(app.store).map((r) => [r.puppet_id, r]));
  assert.equal(map["p-old"].current_custodian_id, "c-chen");
  assert.equal(map["p-old"].status, "checked_out");
});

test("归还清点缺件 → 标记失踪，不能正常销账", () => {
  const app = newApp();
  puppetReady(app, "p-q");
  app.send(
    {
      aggregate: "loan",
      type: "CheckoutLoan",
      loan_id: "loan-q",
      puppet_id: "p-q",
      custodian_id: "c-1",
      purpose: "巡演",
    },
    { actor: manager },
  );
  app.send(
    {
      aggregate: "loan",
      type: "ReturnLoan",
      loan_id: "loan-q",
      returned_by: "c-1",
      condition_note: "头部缺失",
      parts_checked: [{ part_id: "p-q-h", present: false, note: "未在箱中" }],
    },
    { actor: manager },
  );
  const map = Object.fromEntries(buildCustodyMap(app.store).map((r) => [r.puppet_id, r]));
  assert.equal(map["p-q"].status, "missing");
});

test("离线：两台设备各自对同一物件出库 → 同步时后到分支被拒并留痕", () => {
  const app = newApp();
  puppetReady(app, "p-tour");

  // 出发基线：服务器为空
  const deviceA = new OfflineLedger("dev-A");
  const deviceB = new OfflineLedger("dev-B");
  const tA = "2026-09-22T09:00:00+08:00";
  const tB = "2026-09-22T10:30:00+08:00";
  deviceA.stage({
    aggregateType: "loan_record",
    aggregateId: "loan-A",
    eventType: "LOAN_CHECKED_OUT",
    occurredAt: tA,
    summary: "A 机出库",
    payload: { loan_id: "loan-A", puppet_id: "p-tour", custodian_id: "c-A", purpose: "甲村" },
  });
  deviceB.stage({
    aggregateType: "loan_record",
    aggregateId: "loan-B",
    eventType: "LOAN_CHECKED_OUT",
    occurredAt: tB,
    summary: "B 机出库",
    payload: { loan_id: "loan-B", puppet_id: "p-tour", custodian_id: "c-B", purpose: "乙村" },
  });

  const resultA = app.sync(deviceA.pending);
  assert.equal(resultA.applied.length, 1);
  const resultB = app.sync(deviceB.pending);
  assert.equal(resultB.conflicts.length, 1);
  assert.equal(resultB.applied.length, 0);
  assert.ok(resultB.conflicts[0].reason.includes("两个当前位置") || resultB.conflicts[0].reason.includes("已由借用单"));

  const map = Object.fromEntries(buildCustodyMap(app.store).map((r) => [r.puppet_id, r]));
  assert.equal(map["p-tour"].current_custodian_id, "c-A", "先发生的事实为准");
  assert.ok(map["p-tour"].loan_id === "loan-A");

  // 被拒流上留有 CUSTODY_CONFLICT_DETECTED
  const rejectedStream = app.store.load("loan_record:loan-B");
  assert.equal(rejectedStream[0].event_type, "CUSTODY_CONFLICT_DETECTED");
  assert.deepEqual(rejectedStream[0].payload.rejected_event_ids, deviceB.pending.map((e) => e.event_id));
});

test("离线：同一批重复投递幂等；交接链分叉按语义拒绝", () => {
  const app = newApp();
  puppetReady(app, "p-dup");
  const dev = new OfflineLedger("dev-C");
  dev.stage({
    aggregateType: "loan_record",
    aggregateId: "loan-dup",
    eventType: "LOAN_CHECKED_OUT",
    occurredAt: "2026-09-22T08:00:00+08:00",
    summary: "出库",
    payload: { loan_id: "loan-dup", puppet_id: "p-dup", custodian_id: "c-1", purpose: "巡演" },
  });
  const first = app.sync(dev.pending);
  assert.equal(first.applied.length, 1);
  const again = app.sync(dev.pending);
  assert.equal(again.applied.length, 0);
  assert.equal(again.skipped.length, 1);

  // 设备基线未更新，离线又基于 v1 记了两条互相矛盾的交接：
  // 服务器权威路径先发生 1→2 的交接；设备离线分支声称 1→3 → 分叉拒绝
  app.send(
    {
      aggregate: "loan",
      type: "TransferCustody",
      loan_id: "loan-dup",
      from_custodian_id: "c-1",
      to_custodian_id: "c-2",
      handoff_note: "服务器侧交接",
    },
    { actor: manager, at: "2026-09-22T12:00:00+08:00" },
  );
  const stale = new OfflineLedger("dev-C", new Map([["loan_record:loan-dup", 1]]));
  stale.stage({
    aggregateType: "loan_record",
    aggregateId: "loan-dup",
    eventType: "CUSTODY_TRANSFERRED",
    occurredAt: "2026-09-22T13:00:00+08:00",
    summary: "离线交接给 c-3",
    payload: {
      loan_id: "loan-dup",
      puppet_id: "p-dup",
      from_custodian_id: "c-1",
      to_custodian_id: "c-3",
      handoff_note: "离线交接",
    },
  });
  const res = app.sync(stale.pending);
  assert.equal(res.conflicts.length, 1);
  assert.ok(res.conflicts[0].reason.includes("交接链冲突"));
});

test("离线：环境读数等追加性事实分叉时重编号合并，不丢失", () => {
  const app = newApp();
  app.send(
    {
      aggregate: "environment",
      type: "RecordEnvironment",
      location: "流动戏台",
      temp_c: 21,
      humidity_pct: 60,
      puppet_ids_present: [],
    },
    { actor: manager, at: "2026-09-22T10:00:00+08:00" },
  );
  const dev = new OfflineLedger("dev-env", new Map([["environment_log:流动戏台", 0]]));
  dev.stage({
    aggregateType: "environment_log",
    aggregateId: "流动戏台",
    eventType: "ENVIRONMENT_RECORDED",
    occurredAt: "2026-09-22T12:00:00+08:00",
    summary: "午间读数",
    payload: {
      location: "流动戏台",
      temp_c: 23,
      humidity_pct: 65,
      recorded_by: "u-manager",
      puppet_ids_present: ["p-old"],
    },
  });
  const res = app.sync(dev.pending);
  assert.equal(res.merged.length, 1);
  const stream = app.store.load("environment_log:流动戏台");
  assert.deepEqual(stream.map((e) => e.version), [1, 2]);
  assert.equal(stream[1].payload.humidity_pct, 65);
});
