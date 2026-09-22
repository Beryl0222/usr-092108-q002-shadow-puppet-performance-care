import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/errors.js";
import { PART_CONDITION, RELIC_GRADES } from "../src/policy.js";
import { IDS, newApp, seedObjects, seedApprentices, qualify } from "./helpers.js";

test("开裂只冻结相关部件，同件其他部件仍可用", () => {
  const app = newApp();
  seedObjects(app);
  app.inventory.reportDamage({
    object_id: IDS.old,
    reporter_id: IDS.artist,
    findings: [{ part_id: "P-右臂", condition: PART_CONDITION.CRACKED, note: "袖根横裂" }],
  });
  const obj = app.view.objects.get(IDS.old);
  assert.equal(obj.parts.get("P-右臂").frozen, true);
  assert.equal(obj.parts.get("P-右臂").condition, "开裂");
  for (const good of ["P-头茬", "P-胸腹", "P-左臂"]) {
    assert.equal(obj.parts.get(good).frozen, false, `${good} 不应被株连`);
  }
});

test("虫蛀同样只冻结报损部件", () => {
  const app = newApp();
  seedObjects(app);
  app.inventory.reportDamage({
    object_id: IDS.old,
    reporter_id: "r",
    findings: [{ part_id: "P-头茬", condition: PART_CONDITION.WORM_EATEN }],
  });
  assert.equal(app.view.objects.get(IDS.old).parts.get("P-头茬").frozen, true);
  assert.equal(app.view.objects.get(IDS.old).parts.get("P-胸腹").frozen, false);
});

test("修复形成独立层次，返工不覆盖旧痕迹", () => {
  const app = newApp();
  seedObjects(app);
  seedApprentices(app);
  qualify(app, IDS.apprenticeAdult, "修补");
  app.inventory.reportDamage({
    object_id: IDS.old, reporter_id: "r",
    findings: [{ part_id: "P-右臂", condition: PART_CONDITION.CRACKED }],
  });
  app.inventory.recordRepair({
    repair_id: "FX-1", object_id: IDS.old, part_id: "P-右臂",
    restorer_id: IDS.restorer, materials: ["驴皮鳔胶"], techniques: ["裂纹对合"], note: "第一层",
  });
  app.inventory.recordRepair({
    repair_id: "FX-2", object_id: IDS.old, part_id: "P-右臂",
    restorer_id: IDS.restorer, apprentice_id: IDS.apprenticeAdult,
    materials: ["核桃油"], techniques: ["缓性回润"], note: "第二层返工",
  });
  const repairs = app.view.objects.get(IDS.old).repairs;
  assert.equal(repairs.length, 2);
  assert.deepEqual(repairs[0].materials, ["驴皮鳔胶"]);
  assert.deepEqual(repairs[1].materials, ["核桃油"]);
  // 每层材料手法都保留，且修复后在复检前仍冻结
  assert.equal(app.view.objects.get(IDS.old).parts.get("P-右臂").frozen, true);
});

test("修复后须复检合格才解冻", () => {
  const app = newApp();
  seedObjects(app);
  app.inventory.reportDamage({
    object_id: IDS.old, reporter_id: "r",
    findings: [{ part_id: "P-左臂", condition: PART_CONDITION.BRITTLE }],
  });
  app.inventory.recordRepair({
    repair_id: "FX-9", object_id: IDS.old, part_id: "P-左臂",
    restorer_id: IDS.restorer, materials: ["m"], techniques: ["t"],
  });
  assert.equal(app.view.objects.get(IDS.old).parts.get("P-左臂").condition, "已修复待复检");
  app.inventory.clearPart({ object_id: IDS.old, part_id: "P-左臂", inspector_id: IDS.restorer });
  assert.equal(app.view.objects.get(IDS.old).parts.get("P-左臂").frozen, false);
  assert.equal(app.view.objects.get(IDS.old).parts.get("P-左臂").condition, "完好");
});

test("未记录材料或手法的修复被拒绝", () => {
  const app = newApp();
  seedObjects(app);
  assert.throws(
    () => app.inventory.recordRepair({
      repair_id: "FX-x", object_id: IDS.old, part_id: "P-右臂",
      restorer_id: IDS.restorer, materials: [], techniques: ["t"],
    }),
    (e) => e instanceof DomainError && e.code === "MATERIALS_REQUIRED"
  );
});

test("复制品必须以核准复制品等级登记才能成为替身", () => {
  const app = newApp();
  seedObjects(app);
  assert.throws(
    () => app.inventory.approveSubstitute({
      object_id: IDS.old, replica_id: IDS.old, role_id: "ROLE-老旦", approved_by: "x",
    }),
    (e) => e instanceof DomainError && e.code === "NOT_A_REPLICA"
  );
});

test("学徒修补层级不足不得参与一级文物修复", () => {
  const app = newApp();
  seedObjects(app);
  seedApprentices(app);
  assert.throws(
    () => app.inventory.recordRepair({
      repair_id: "FX-n", object_id: IDS.old, part_id: "P-右臂",
      restorer_id: IDS.restorer, apprentice_id: IDS.apprenticeAdult,
      materials: ["m"], techniques: ["t"],
    }),
    (e) => e instanceof DomainError && e.code === "REPAIR_LEVEL_INSUFFICIENT"
  );
});

test("未成年学徒不得对真品动手修复", () => {
  const app = newApp();
  seedObjects(app);
  seedApprentices(app);
  assert.throws(
    () => app.inventory.recordRepair({
      repair_id: "FX-m", object_id: IDS.old, part_id: "P-右臂",
      restorer_id: IDS.restorer, apprentice_id: IDS.apprenticeMinor,
      materials: ["m"], techniques: ["t"],
    }),
    (e) => e instanceof DomainError && e.code === "MINOR_REPAIR_FORBIDDEN"
  );
});
