/**
 * 保管链服务：借用、多人交接、在途离线记录、归还清点。
 *
 * 单一当前位置如何保证：
 * - 每件影偶的保管事件是一条链；离线客户端在事件上携带 previous_event_id（它所见到的链尾）。
 * - 重放时若 previous_event_id 与服务端链尾不一致，说明两台离线终端各自推进了链
 *   （同一物件被两边同时主张持有），此时保留双方交接记录，并立即追加“位置争议”，
 *   当前位置冻结为“待复核”，在人工复核归位前拒绝一切借出/交接/归还。
 * - (client_id, client_seq) 幂等：同一条离线记录重传只返回首次结果，不会制造第二个位置。
 * - 在线交接则强校验“交出人必须是当前持有人”，从源头杜绝两端并存。
 */
import { DomainError } from "../errors.js";

export class CustodyService {
  #store;
  #view;

  constructor({ store, view }) {
    this.#store = store;
    this.#view = view;
  }

  /** 借出/携出（赶赴乡村节庆、传习所上课）。要求物件在库且无未决争议。 */
  checkOut(input) {
    const idem = this.#idempotent(input.offline);
    if (idem) return idem;

    const chain = this.#view.custody.get(input.object_id);
    if (chain?.disputed)
      throw new DomainError("CUSTODY_DISPUTED", `物件位置存在未决争议，复核前不得借出`, {
        object_id: input.object_id,
      });
    if (chain?.current?.holder_id)
      throw new DomainError("ALREADY_CHECKED_OUT", `物件已在 ${chain.current.holder_name} 处，未归还前不得再借`, {
        object_id: input.object_id,
        current_holder: chain.current.holder_id,
      });

    this.#assertChainLink(input.object_id, input.offline);

    return this.#store.append("OBJECT_CHECKED_OUT", input.object_id, {
      object_id: input.object_id,
      holder_id: input.holder_id,
      holder_name: input.holder_name,
      purpose: input.purpose,
      location: input.location,
      expected_return: input.expected_return,
      handler_id: input.handler_id,
    }, {
      summary: `${input.holder_name} 携《${this.#nameOf(input.object_id)}》赴${input.location}（${input.purpose}）`,
      offline: input.offline,
    });
  }

  /**
   * 多人交接。在线时交出人必须是当前持有人；离线时按链上指针判分叉。
   */
  transfer(input) {
    const idem = this.#idempotent(input.offline);
    if (idem) return idem;

    const chain = this.#view.custody.get(input.object_id);
    if (chain?.disputed)
      throw new DomainError("CUSTODY_DISPUTED", `物件位置存在未决争议，复核前不得交接`, {
        object_id: input.object_id,
      });
    if (!chain?.current?.holder_id)
      throw new DomainError("NOT_CHECKED_OUT", `物件当前在库，无保管人可交接`);

    // 离线分叉：提交方基于的链尾已不是服务端链尾 → 双方都在主张持有。
    const fork = this.#chainFork(input.object_id, input.offline);
    if (fork) return this.#raiseDispute(input.object_id, fork, {
      competing: [fork.tailEventId, input.offline.previous_event_id].filter(Boolean),
      detail: `离线交接分叉：${chain.current.holder_name}（链上）与 ${input.to_holder_name}（离线提交）均主张持有《${this.#nameOf(input.object_id)}》`,
      detected_by: input.handler_id,
      incoming: {
        type: "CUSTODY_TRANSFERRED",
        payload: {
          object_id: input.object_id,
          from_holder_id: input.from_holder_id,
          to_holder_id: input.to_holder_id,
          to_holder_name: input.to_holder_name,
          location: input.location,
          handler_id: input.handler_id,
          ...(input.note ? { note: input.note } : {}),
        },
        summary: `（离线）交接给 ${input.to_holder_name}`,
        offline: input.offline,
      },
    });

    if (chain.current.holder_id !== input.from_holder_id)
      throw new DomainError(
        "NOT_CURRENT_HOLDER",
        `交出人 ${input.from_holder_id} 不是当前持有人 ${chain.current.holder_id}`,
        { current_holder: chain.current.holder_id }
      );

    return this.#store.append("CUSTODY_TRANSFERRED", input.object_id, {
      object_id: input.object_id,
      from_holder_id: input.from_holder_id,
      to_holder_id: input.to_holder_id,
      to_holder_name: input.to_holder_name,
      location: input.location,
      handler_id: input.handler_id,
      note: input.note,
    }, {
      summary: `交接：${chain.current.holder_name} → ${input.to_holder_name}@${input.location}`,
      offline: input.offline,
    });
  }

  /**
   * 归还清点：按影偶全部在册部件核对实际交回部件，自动得出缺失清单。
   * 物件回库，但若部件缺失会明确标记 incomplete，留待损伤追溯，不得当作完好入库。
   */
  returnObject(input) {
    const idem = this.#idempotent(input.offline);
    if (idem) return idem;

    const chain = this.#view.custody.get(input.object_id);
    if (chain?.disputed)
      throw new DomainError("CUSTODY_DISPUTED", `物件位置存在未决争议，不能按普通归还处理，须先复核归位`);
    if (!chain?.current?.holder_id)
      throw new DomainError("NOT_CHECKED_OUT", `物件当前在库，无需归还`);
    if (chain.current.holder_id !== input.returned_by)
      throw new DomainError(
        "NOT_CURRENT_HOLDER",
        `归还人 ${input.returned_by} 不是当前持有人 ${chain.current.holder_id}`
      );

    this.#assertChainLink(input.object_id, input.offline);

    const obj = this.#view.objects.get(input.object_id);
    const expected = obj ? [...obj.parts.keys()] : [];
    const returned = new Set(input.checked_part_ids ?? expected);
    const missing = expected.filter((pid) => !returned.has(pid));
    const complete = missing.length === 0;

    return this.#store.append("OBJECT_RETURNED", input.object_id, {
      object_id: input.object_id,
      returned_by: input.returned_by,
      received_by: input.received_by,
      location: input.location,
      complete,
      missing_part_ids: missing,
      note: input.note,
    }, {
      summary: complete
        ? `《${this.#nameOf(input.object_id)}》清点完整，归库`
        : `《${this.#nameOf(input.object_id)}》归库但缺失 ${missing.length} 个部件：${missing.join("、")}`,
      offline: input.offline,
    });
  }

  /** 争议复核归位：以人工核实的唯一持有人/位置为准，解除争议。 */
  reconcile({ object_id, holder_id, location, reconciled_by, note }) {
    const chain = this.#view.custody.get(object_id);
    if (!chain?.disputed)
      throw new DomainError("NO_DISPUTE", `该物件没有未决位置争议，无需复核`);
    return this.#store.append("CUSTODY_RECONCILED", object_id, {
      object_id,
      holder_id,
      location,
      reconciled_by,
      note,
    }, { summary: `位置争议复核归位：${location}${holder_id ? `（持有人 ${holder_id}）` : "（归库）"}` });
  }

  /** 当前位置（任何时刻每件影偶至多一个）。 */
  currentLocation(objectId) {
    const chain = this.#view.custody.get(objectId);
    if (!chain) return { holder_id: null, location: "传习所库房", disputed: false };
    return { ...chain.current, disputed: chain.disputed };
  }

  // —— 离线链与幂等 ——

  #idempotent(offline) {
    if (!offline) return null;
    return this.#store.findOfflineEvent(offline.client_id, offline.client_seq);
  }

  /** 返回链尾事件标识；无链时为 null。 */
  #tailEventId(objectId) {
    const chain = this.#view.custody.get(objectId);
    if (!chain || chain.history.length === 0) return null;
    return chain.history[chain.history.length - 1].event_id;
  }

  /**
   * 判分叉。规则：
   * - 无链：离线首条事件 previous_event_id 必须为空；
   * - 有链：previous_event_id 必须等于链尾；
   * - 在线事件（无 offline）不做指针校验，改由持有人强校验保证一致。
   * 返回 null 表示链连续；否则返回分叉详情。
   */
  #chainFork(objectId, offline) {
    if (!offline) return null;
    const tail = this.#tailEventId(objectId);
    const prev = offline.previous_event_id ?? null;
    if (prev === tail) return null;
    return { tailEventId: tail, submittedPrev: prev };
  }

  #assertChainLink(objectId, offline) {
    const fork = this.#chainFork(objectId, offline);
    if (fork)
      throw new DomainError(
        "CHAIN_OUT_OF_SYNC",
        `离线记录所基于的链尾 ${fork.submittedPrev ?? "（空）"} 与当前链尾 ${fork.tailEventId ?? "（空）"} 不一致`,
        { object_id: objectId, ...fork }
      );
  }

  /**
   * 分叉处理：先把离线终端的交接说法如实留档，再立刻冻结为位置争议。
   * 投影保证争议事件之后 current 唯一指向“待复核”。
   */
  #raiseDispute(objectId, fork, ctx) {
    const incoming = ctx.incoming;
    const recorded = this.#store.append(incoming.type, objectId, incoming.payload, {
      summary: incoming.summary,
      offline: incoming.offline,
    });
    // 两种位置主张都留证：服务端链尾说法与离线终端刚同步上来的说法。
    const competing = [...new Set([...ctx.competing, recorded.event_id])];
    return this.#store.append("CUSTODY_DISPUTE_DETECTED", objectId, {
      object_id: objectId,
      competing_event_ids: competing,
      detail: ctx.detail,
      detected_by: ctx.detected_by,
    }, { summary: `检测到位置分叉，冻结为待复核：《${this.#nameOf(objectId)}》` });
  }

  #nameOf(objectId) {
    return this.#view.objects.get(objectId)?.name ?? objectId;
  }
}
