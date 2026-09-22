import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
import { assertValidContract, EVENT_CATALOG } from "../src/contracts.js";
import { ContractError } from "../src/errors.js";

test("样例符合领域信封约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("样例同时符合完整事件契约（类型-聚合匹配、负载结构）", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => assertValidContract(sample));
  assert.equal(EVENT_CATALOG.OBJECT_REGISTERED.aggregate, "puppet_object");
});

test("事件类型与聚合类型不匹配被拒绝", () => {
  const base = {
    event_id: "e1",
    event_type: "DAMAGE_REPORTED",
    aggregate_type: "performance_plan",
    aggregate_id: "x",
    occurred_at: "2026-09-20T18:00:00+08:00",
    version: 1,
    summary: "错配",
    payload: {
      object_id: "x",
      reporter_id: "r",
      findings: [{ part_id: "p1", condition: "开裂" }],
    },
  };
  assert.throws(() => assertValidContract(base), ContractError);
});

test("负载字段类型/枚举不合法被拒绝", () => {
  const event = {
    event_id: "e2",
    event_type: "ENVIRONMENT_RECORDED",
    aggregate_type: "environment_record",
    aggregate_id: "env1",
    occurred_at: "2026-09-20T18:00:00+08:00",
    version: 1,
    summary: "湿度越界类型错误",
    payload: { reading_id: "env1", location: "库房", humidity: "潮湿", temperature: 22, recorded_by: "r" },
  };
  assert.throws(() => assertValidContract(event), ContractError);
});

test("离线信封缺少链序号被拒绝", () => {
  const event = {
    event_id: "e3",
    event_type: "OBJECT_CHECKED_OUT",
    aggregate_type: "custody_record",
    aggregate_id: "o1",
    occurred_at: "2026-09-20T18:00:00+08:00",
    version: 1,
    summary: "离线但无序号",
    payload: {
      object_id: "o1", holder_id: "h", holder_name: "H",
      purpose: "演出", location: "村里", handler_id: "mgr",
    },
    offline: { client_id: "dev1" },
  };
  assert.throws(() => assertValidContract(event), ContractError);
});
