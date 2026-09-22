import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { EVENT_CATALOG } from "../src/contracts.js";

test("已生成的 JSON Schema 与事件目录保持一致（事件类型与聚合映射）", async () => {
  const schema = JSON.parse(
    await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8")
  );
  assert.deepEqual([...schema.properties.event_type.enum].sort(), Object.keys(EVENT_CATALOG).sort());
  assert.deepEqual(
    [...schema.properties.aggregate_type.enum].sort(),
    [...new Set(Object.values(EVENT_CATALOG).map((c) => c.aggregate))].sort()
  );
  for (const branch of schema.oneOf) {
    const type = branch.properties.event_type.const;
    assert.equal(branch.properties.aggregate_type.const, EVENT_CATALOG[type].aggregate);
  }
});
