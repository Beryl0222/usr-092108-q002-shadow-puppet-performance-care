import { EventStore } from "../store/eventStore.js";
import { puppetAggregate } from "./puppetAggregate.js";
import { apprenticeAggregate } from "./apprenticeAggregate.js";
import { environmentAggregate } from "./environmentAggregate.js";
import { loanAggregate } from "./loanAggregate.js";

/**
 * 跨聚合只读视图：每次按需重放全量事件（内存实现，数据量小）。
 * 持久化实现可替换为投影表。放行策略只能通过这里读其他聚合，
 * 不能把别的聚合状态写进自己的流。
 */
export class Registry {
  constructor(store) {
    this.store = store;
  }

  puppet(puppetId) {
    return foldOne(this.store, puppetAggregate, puppetId);
  }

  apprentice(apprenticeId) {
    return foldOne(this.store, apprenticeAggregate, apprenticeId);
  }

  environment(location) {
    return foldOne(this.store, environmentAggregate, location);
  }

  loanByPuppet(puppetId) {
    // 一个影偶同一时刻至多一条未结清借用；扫描所有 loan_record 流。
    // 只有冲突留痕、从未成功出库的流（status=null）不计在内。
    const open = [];
    for (const key of this.store.keys()) {
      if (!key.startsWith("loan_record:")) continue;
      const loan = foldKey(this.store, loanAggregate, key);
      if (
        loan &&
        loan.loan &&
        loan.puppet_id === puppetId &&
        ["checked_out", "in_transfer", "missing"].includes(loan.status)
      ) {
        open.push(loan);
      }
    }
    return open[0] ?? null;
  }

  /** 某场地在 at 之前最近一次环境读数（无窗口限制时返回 null）。 */
  latestEnvironment(location, at) {
    const env = this.environment(location);
    if (!env || env.readings.length === 0) return null;
    const prior = env.readings.filter((r) => r.at <= at);
    return prior[prior.length - 1] ?? null;
  }

  /**
   * 为老件查找可顶替指定剧目角色、且覆盖所需部件的已核准替身。
   * covers_part_ids 为空表示整偶替身；非空时须包含条目所需全部老件部件。
   * 替身部件编号独立于老件，其自身可用性按“替身无任何冻结部件”判断。
   */
  findSubstitutes(antiquePuppetId, playId, role, requiredPartIds = []) {
    const antique = this.puppet(antiquePuppetId);
    if (!antique) return [];
    const candidates = [];
    for (const sub of antique.substitutes) {
      if (!sub.approvedRoles.has(`${playId}::${role}`)) continue;
      // 整偶条目（未声明部件）只能用整偶替身；部件条目可用整偶替身或覆盖全部所需部件的部件替身
      const wholeRole = requiredPartIds.length === 0;
      const coversNeeded = wholeRole
        ? sub.covers_part_ids.length === 0
        : sub.covers_part_ids.length === 0 || requiredPartIds.every((pid) => sub.covers_part_ids.includes(pid));
      if (!coversNeeded) continue;
      const replica = this.puppet(sub.replica_puppet_id);
      if (!replica?.puppet || replica.puppet.artifact_class !== "replica") continue;
      const replicaFrozen = [...replica.parts.values()].some((part) => part.status === "frozen");
      if (replicaFrozen) continue;
      candidates.push({
        replica_puppet_id: sub.replica_puppet_id,
        covers_part_ids: sub.covers_part_ids,
      });
    }
    return candidates;
  }
}

function foldKey(store, def, streamKey) {
  const events = store.load(streamKey);
  if (events.length === 0) return null;
  let state = def.initial();
  for (const event of events) state = def.fold(state, event);
  return state;
}

function foldOne(store, def, aggregateId) {
  return foldKey(store, def, EventStore.streamKey(def.aggregateType, aggregateId));
}
