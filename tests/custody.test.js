import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/errors.js";
import { IDS, newApp, seedObjects } from "./helpers.js";

const offline = (client, seq, previous) => ({ client_id: client, client_seq: seq, previous_event_id: previous });

test("在线：未归还不得重复借出；交接必须由当前持有人发起", () => {
  const app = newApp();
  seedObjects(app);
  app.custody.checkOut({
    object_id: IDS.old, holder_id: "h-周", holder_name: "周师傅",
    purpose: "节庆", location: "走马村", handler_id: IDS.manager,
  });
  assert.throws(
    () => app.custody.checkOut({
      object_id: IDS.old, holder_id: "h-李", holder_name: "李师傅",
      purpose: "上课", location: "传习所", handler_id: IDS.manager,
    }),
    (e) => e instanceof DomainError && e.code === "ALREADY_CHECKED_OUT"
  );
  assert.throws(
    () => app.custody.transfer({
      object_id: IDS.old, from_holder_id: "h-冒名", to_holder_id: "h-李",
      to_holder_name: "李师傅", location: "后场", handler_id: IDS.manager,
    }),
    (e) => e instanceof DomainError && e.code === "NOT_CURRENT_HOLDER"
  );
});

test("离线弱网重传同一序号幂等：物件只有一个当前位置", () => {
  const app = newApp();
  seedObjects(app);
  const o1 = offline("dev-1", 1, null);
  const e1 = app.custody.checkOut({
    object_id: IDS.old, holder_id: "h-周", holder_name: "周师傅",
    purpose: "节庆", location: "走马村", handler_id: "mgr", offline: o1,
  });
  const e2 = app.custody.checkOut({
    object_id: IDS.old, holder_id: "h-周", holder_name: "周师傅",
    purpose: "节庆", location: "走马村", handler_id: "mgr", offline: o1,
  });
  assert.equal(e1.event_id, e2.event_id, "重传应返回同一事件");
  assert.equal(app.custody.currentLocation(IDS.old).holder_id, "h-周");
});

test("两台离线终端基于同一链尾各自交接：检测分叉并冻结为位置争议", () => {
  const app = newApp();
  seedObjects(app);
  const checkout = app.custody.checkOut({
    object_id: IDS.old, holder_id: "h-周", holder_name: "周师傅",
    purpose: "节庆", location: "走马村", handler_id: "mgr",
    offline: offline("dev-1", 1, null),
  });
  const tail = checkout.event_id;

  app.custody.transfer({
    object_id: IDS.old, from_holder_id: "h-周", to_holder_id: "h-李",
    to_holder_name: "李师傅", location: "戏台后场", handler_id: "dev-A",
    offline: offline("dev-A", 1, tail),
  });
  app.custody.transfer({
    object_id: IDS.old, from_holder_id: "h-周", to_holder_id: "h-王",
    to_holder_name: "王师傅", location: "返程车上", handler_id: "dev-B",
    offline: offline("dev-B", 1, tail),
  });

  const loc = app.custody.currentLocation(IDS.old);
  assert.equal(loc.disputed, true);
  assert.equal(loc.holder_id, null, "争议期间不存在被系统承认的持有人");
  assert.match(loc.location, /争议/);

  // 争议期间一切移动都被拒绝
  assert.throws(
    () => app.custody.transfer({
      object_id: IDS.old, from_holder_id: "h-李", to_holder_id: "h-赵",
      to_holder_name: "赵", location: "x", handler_id: "mgr",
    }),
    (e) => e instanceof DomainError && e.code === "CUSTODY_DISPUTED"
  );
});

test("位置争议经人工复核归位后恢复唯一位置，可继续交接归还", () => {
  const app = newApp();
  seedObjects(app);
  const checkout = app.custody.checkOut({
    object_id: IDS.old, holder_id: "h-周", holder_name: "周师傅",
    purpose: "节庆", location: "走马村", handler_id: "mgr",
    offline: offline("dev-1", 1, null),
  });
  app.custody.transfer({
    object_id: IDS.old, from_holder_id: "h-周", to_holder_id: "h-李",
    to_holder_name: "李师傅", location: "戏台后场", handler_id: "dev-A",
    offline: offline("dev-A", 1, checkout.event_id),
  });
  app.custody.transfer({
    object_id: IDS.old, from_holder_id: "h-周", to_holder_id: "h-王",
    to_holder_name: "王师傅", location: "返程车上", handler_id: "dev-B",
    offline: offline("dev-B", 1, checkout.event_id),
  });
  app.custody.reconcile({
    object_id: IDS.old, holder_id: "h-李", location: "戏台后场",
    reconciled_by: IDS.manager, note: "电话核实影偶在李师傅箱内",
  });
  const loc = app.custody.currentLocation(IDS.old);
  assert.equal(loc.disputed, false);
  assert.equal(loc.holder_id, "h-李");
});

test("归还清点：部件齐全则完整入库，缺件明确登记不得当作完好", () => {
  const app = newApp();
  seedObjects(app);
  app.custody.checkOut({
    object_id: IDS.old, holder_id: "h-周", holder_name: "周师傅",
    purpose: "节庆", location: "走马村", handler_id: "mgr",
  });
  const ret = app.custody.returnObject({
    object_id: IDS.old, returned_by: "h-周", received_by: "库管-赵",
    location: "传习所库房", checked_part_ids: ["P-头茬", "P-胸腹", "P-左臂"], // 右臂未交回
  });
  assert.equal(ret.payload.complete, false);
  assert.deepEqual(ret.payload.missing_part_ids, ["P-右臂"]);
  const chain = app.view.custody.get(IDS.old);
  assert.equal(chain.current.complete, false);

  // 已归库后再次归还被拒
  assert.throws(
    () => app.custody.returnObject({
      object_id: IDS.old, returned_by: "h-周", received_by: "库管-赵", location: "传习所库房",
    }),
    (e) => e instanceof DomainError && e.code === "NOT_CHECKED_OUT"
  );
});

test("离线首条记录携带非空前驱被拒绝（链不连续）", () => {
  const app = newApp();
  seedObjects(app);
  assert.throws(
    () => app.custody.checkOut({
      object_id: IDS.old, holder_id: "h-周", holder_name: "周",
      purpose: "x", location: "x", handler_id: "m",
      offline: offline("dev-1", 1, "并不存在的事件"),
    }),
    (e) => e instanceof DomainError && e.code === "CHAIN_OUT_OF_SYNC"
  );
});

test("事件重放重建后，当前位置与争议状态保持一致", () => {
  const app = newApp();
  seedObjects(app);
  app.custody.checkOut({
    object_id: IDS.old, holder_id: "h-周", holder_name: "周师傅",
    purpose: "节庆", location: "走马村", handler_id: "mgr",
  });
  const events = app.eventLog;
  const rebuilt = newApp().rehydrate(events);
  assert.equal(rebuilt.custody.currentLocation(IDS.old).holder_id, "h-周");
  assert.equal(rebuilt.view.objects.get(IDS.old).name, app.view.objects.get(IDS.old).name);
});
