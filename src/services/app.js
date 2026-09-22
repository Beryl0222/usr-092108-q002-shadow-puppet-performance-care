/**
 * 应用装配：把事件存储、读模型与各领域服务组装为同一后台，
 * 并提供三类角色的查询视图：
 *   - 演出经理：不伤老件完成换场（场次就绪度、逐角色核验、可用替身）
 *   - 修缮师：从损伤追到最近使用与环境（使用场次、许可、读数、保管链）
 *   - 传承人：学徒独立操控/制作/修补的真实能力
 */
import { EventStore } from "../store.js";
import { Projection, highestReviewedLevel } from "../projection.js";
import { InventoryService } from "./inventory.js";
import { TrainingService } from "./training.js";
import { PerformanceService } from "./performance.js";
import { CustodyService } from "./custody.js";
import {
  INDEPENDENT_LEVEL,
  PART_CONDITION,
  TRAINING_DISCIPLINES,
  TRAINING_LEVELS,
  assessEnvironment,
} from "../policy.js";

export class TroupeApplication {
  constructor() {
    this.view = new Projection();
    this.store = new EventStore(this.view);
    this.training = new TrainingService({ store: this.store, view: this.view });
    this.inventory = new InventoryService({ store: this.store, view: this.view, training: this.training });
    this.performances = new PerformanceService({ store: this.store, view: this.view, training: this.training });
    this.custody = new CustodyService({ store: this.store, view: this.view });
  }

  /** 从事件流重建（离线终端同步、服务重启）。 */
  rehydrate(events) {
    this.view.reset();
    this.store.rebuild(events);
    return this;
  }

  get eventLog() {
    return this.store.events;
  }

  // —— 演出经理视图 ——

  /**
   * 场次就绪总览。给一场演出（通常带开演前最新环境读数）逐角色计算三因子，
   * 并为被冻结老件列出可立即改派的核准复制品，使经理“换场而不伤老件”。
   */
  managerShowStatus(performanceId, { reading_id } = {}) {
    const show = this.view.performances.get(performanceId);
    if (!show) return null;
    const reading = reading_id
      ? this.view.environmentReadings.get(reading_id)
      : [...this.view.environmentReadings.values()]
          .filter((r) => r.performance_id === performanceId)
          .at(-1);

    const roles = [...show.roles.values()].map((role) => {
      const obj = this.view.objects.get(role.current.object_id);
      const scope = role.current.part_ids ?? [...obj.parts.keys()];
      const frozen = scope.map((p) => obj.parts.get(p)).filter((p) => p?.frozen);
      const verdict = this.performances.evaluate({
        performance: show,
        role,
        object_id: role.current.object_id,
        operator_id: role.current.operator_id,
        part_ids: role.current.part_ids,
        reading,
        special_approval: role.latest_clearance?.special_approval ?? null,
        master_present: Boolean(role.latest_clearance?.special_approval),
      });
      const clearanceValid =
        role.latest_clearance?.granted &&
        role.latest_clearance.object_id === role.current.object_id;

      const backupOptions = frozen.length
        ? this.#approvedReplicas(obj.object_id, role.role_id, show.title)
        : [];

      return {
        role_id: role.role_id,
        role_name: role.role_name,
        object_id: obj.object_id,
        object_name: obj.name,
        grade: obj.grade,
        operator_id: role.current.operator_id,
        frozen_parts: frozen.map((p) => ({ part_id: p.part_id, name: p.name, condition: p.condition })),
        clearance_on_record: role.latest_clearance
          ? {
              granted: role.latest_clearance.granted,
              reasons: role.latest_clearance.reasons,
              for_object_id: role.latest_clearance.object_id,
            }
          : null,
        ready: verdict.can_go_ahead && clearanceValid,
        blocking_reasons: [
          ...verdict.reasons,
          ...(!clearanceValid ? ["当前派戏对象与已获许可不一致或尚无许可，须重新核验"] : []),
        ],
        approved_backups: backupOptions.map((r) => ({
          replica_id: r.object_id,
          name: r.name,
          repertoire: r.repertoire,
        })),
      };
    });

    return {
      performance_id: performanceId,
      title: show.title,
      venue: show.venue,
      purpose: show.purpose,
      scheduled_start: show.scheduled_start,
      ticket_sold: show.ticket_sold,
      status: show.status,
      environment: reading
        ? { reading_id: reading.reading_id, ...assessEnvironment(reading) }
        : null,
      ready: roles.every((r) => r.ready),
      roles,
    };
  }

  #approvedReplicas(originalId, roleId, playTitle) {
    const original = this.view.objects.get(originalId);
    const out = [];
    for (const [replicaId, roleSet] of original.substitutes.entries()) {
      if (!roleSet.has(roleId)) continue;
      const replica = this.view.objects.get(replicaId);
      if (!replica || [...replica.parts.values()].some((p) => p.frozen)) continue;
      if (replica.repertoire.length && !replica.repertoire.includes(playTitle)) continue;
      out.push(replica);
    }
    return out;
  }

  // —— 修缮师视图 ——

  /**
   * 损伤追溯：从一件影偶的当前损伤出发，给出
   * 每个受损部件的报损记录、历次修复层次、报损前最近使用场次、
   * 该场次绑定的环境读数，以及当前保管位置。
   */
  restorerTrace(objectId) {
    const obj = this.view.objects.get(objectId);
    if (!obj) return null;
    const events = this.store.events;

    // reading_id -> 读数；由核验请求建立 场次/物件 -> 读数 的关联
    const requests = events
      .filter((e) => e.event_type === "STAGE_CLEARANCE_REQUESTED" && e.payload.object_id === objectId)
      .map((e) => e.payload);
    // 该影偶历史参演场次登记过的全部环境读数（换角后请求会绑定替身，故还要按场次兜底）
    const readingsForShow = (performanceId) =>
      [...this.view.environmentReadings.values()]
        .filter((r) => r.performance_id === performanceId)
        .sort((a, b) => (a.at < b.at ? -1 : 1));

    const uses = [...this.view.performances.values()].flatMap((show) =>
      [...show.roles.values()].flatMap((role) =>
        role.casts
          // 历史派戏也要追到：报损换替角后，原件已不在 role.current
          .filter((cast) => cast.object_id === objectId)
          .map((cast) => {
            const req = requests.find((r) => r.performance_id === show.performance_id && r.role_id === role.role_id);
            // 优先原件自身核验时的读数；换角后核验已绑替身，则回退到该场次最早读数（开演前环境）
            const reading = req
              ? this.view.environmentReadings.get(req.reading_id)
              : readingsForShow(show.performance_id)[0] ?? null;
            const clearanceForCast = role.clearances.find(
              (c) => c.object_id === objectId && (!cast.at || c.at >= cast.at)
            );
            return {
              performance_id: show.performance_id,
              title: show.title,
              venue: show.venue,
              purpose: show.purpose,
              scheduled_start: show.scheduled_start,
              role_id: role.role_id,
              role_name: role.role_name,
              operator_id: cast.operator_id,
              is_current_cast: role.current?.object_id === objectId,
              cast_at: cast.at,
              clearance: clearanceForCast
                ? { granted: clearanceForCast.granted, reasons: clearanceForCast.reasons, at: clearanceForCast.at }
                : null,
              environment: reading
                ? {
                    reading_id: reading.reading_id,
                    humidity: reading.humidity,
                    temperature: reading.temperature,
                    ...assessEnvironment(reading),
                  }
                : null,
            };
          })
      )
    );
    uses.sort((a, b) => (a.scheduled_start < b.scheduled_start ? 1 : -1));

    const damagedParts = [...obj.parts.values()]
      // 当前异常，或历史上曾报损、曾修复（修缮师需要从旧伤一路追到现状）
      .filter(
        (part) =>
          part.frozen ||
          part.condition !== PART_CONDITION.SOUND ||
          part.history.some((h) => h.kind === "损伤上报") ||
          obj.repairs.some((layer) => layer.part_id === part.part_id)
      )
      .map((part) => ({
        part_id: part.part_id,
        name: part.name,
        condition: part.condition,
        frozen: part.frozen,
        damage_events: part.history
          .filter((h) => h.kind === "损伤上报")
          .map((h) => ({ at: h.at, by: h.by, condition: h.condition, note: h.note, event_id: h.event_id })),
        inspections: part.history
          .filter((h) => h.kind === "巡检")
          .map((h) => ({ at: h.at, by: h.by, condition: h.condition, note: h.note })),
        repairs: obj.repairs
          .filter((layer) => layer.part_id === part.part_id)
          .map((layer, idx) => ({
            layer: idx + 1,
            repair_id: layer.repair_id,
            restorer_id: layer.restorer_id,
            apprentice_id: layer.apprentice_id,
            materials: layer.materials,
            techniques: layer.techniques,
            note: layer.note,
            at: layer.at,
          })),
        timeline: part.history.map((h) => ({ kind: h.kind, condition: h.condition, at: h.at, by: h.by ?? null })),
      }));

    const chain = this.view.custody.get(objectId);
    return {
      object_id: objectId,
      name: obj.name,
      grade: obj.grade,
      dynasty: obj.dynasty,
      year_estimate: obj.year_estimate,
      damaged_parts: damagedParts,
      recent_uses: uses,
      custody: chain
        ? {
            disputed: chain.disputed,
            current: chain.current,
            recent: chain.history.slice(-5),
          }
        : { disputed: false, current: { location: "传习所库房" }, recent: [] },
    };
  }

  // —— 传承人视图 ——

  /**
   * 学徒真实能力名册：分层训练进度、师傅复核、是否具备独立操控/制作/修补资格，
   * 以及受未成年封顶后的实际可接触级别。
   */
  masterApprenticeReport() {
    return [...this.view.apprentices.values()].map((app) => {
      const disciplines = Object.values(TRAINING_DISCIPLINES).map((discipline) => {
        const ladder = TRAINING_LEVELS[discipline];
        const topIdx = highestReviewedLevel(app, discipline);
        const independentLevel = INDEPENDENT_LEVEL[discipline];
        const qualified = Boolean(app.training[discipline]?.[independentLevel]?.qualified_at);
        return {
          discipline,
          highest_reviewed_level: topIdx >= 0 ? ladder[topIdx] : null,
          independent_qualified: qualified,
          steps: ladder.map((level) => {
            const state = app.training[discipline]?.[level];
            const reviews = state?.reviews ?? [];
            return {
              level,
              logged: Boolean(state?.logged_at),
              reviews: reviews.map((r) => ({ reviewer_id: r.reviewer_id, passed: r.passed, at: r.at })),
              passed: reviews.some((r) => r.passed),
            };
          }),
        };
      });
      return {
        apprentice_id: app.apprentice_id,
        name: app.name,
        minor: app.minor,
        master_id: app.master_id,
        handling_level: this.training.handlingLevel(app.apprentice_id),
        can_manipulate_independently: disciplines.find(
          (d) => d.discipline === TRAINING_DISCIPLINES.MANIPULATION
        ).independent_qualified,
        can_make_independently: disciplines.find(
          (d) => d.discipline === TRAINING_DISCIPLINES.MAKING
        ).independent_qualified,
        can_repair_independently: disciplines.find(
          (d) => d.discipline === TRAINING_DISCIPLINES.REPAIR
        ).independent_qualified,
        disciplines,
      };
    });
  }
}
