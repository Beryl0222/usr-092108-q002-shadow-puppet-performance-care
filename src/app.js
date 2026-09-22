import { EventStore } from "./store/eventStore.js";
import { runCommand } from "./aggregates/runner.js";
import { Registry } from "./aggregates/registry.js";
import { puppetAggregate } from "./aggregates/puppetAggregate.js";
import { apprenticeAggregate } from "./aggregates/apprenticeAggregate.js";
import { environmentAggregate } from "./aggregates/environmentAggregate.js";
import { planAggregate } from "./aggregates/planAggregate.js";
import { loanAggregate } from "./aggregates/loanAggregate.js";
import { syncBatch, OfflineLedger } from "./aggregates/offlineSync.js";

const DEFINITIONS = {
  puppet: puppetAggregate,
  apprentice: apprenticeAggregate,
  environment: environmentAggregate,
  plan: planAggregate,
  loan: loanAggregate,
};

/**
 * 应用门面：命令统一入口，自动注入跨聚合只读注册中心。
 * 用法：
 *   app.send({ aggregate: "puppet", type: "RegisterPuppet", ... }, { actor, at, batchId, expectedVersion })
 */
export class Application {
  constructor(store = new EventStore()) {
    this.store = store;
    this.registry = new Registry(store);
  }

  send(command, context = {}) {
    const def = DEFINITIONS[command.aggregate];
    if (!def) throw new Error(`未知聚合：${command.aggregate}`);
    return runCommand(this.store, def, command, { ...context, registry: this.registry });
  }

  /** 离线设备整批同步。 */
  sync(events) {
    return syncBatch(this.store, events, { registry: this.registry });
  }

  makeLedger(deviceId) {
    const base = new Map();
    for (const key of this.store.keys()) base.set(key, this.store.streamVersion(key));
    return new OfflineLedger(deviceId, base);
  }
}

export { OfflineLedger };
