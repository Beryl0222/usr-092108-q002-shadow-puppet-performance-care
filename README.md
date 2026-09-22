# 皮影古件演出保全

鹤峰春生皮影剧团的统一后台领域内核：把**影偶实体、历史年代、部件状况、修补层次、可用剧目、复制替身、收纳环境、演出排练、借用责任、学徒操作资格**纳入同一套只追加事件模型。

本仓库不依赖任何第三方库，纯 Node.js（ESM、`node:test`）。

## 核心原则

- **事件只追加、不改写**：事件标识、发生时间、版本一经接收即固定；业务更正（解冻、换人、取消）一律产生后继事件。
- **上台三重门**：老件是否上台由①保存状态（部件无冻结、剧目角色适用、未失踪）、②环境窗口（开场前 6 小时内读数，湿度 ≤70%RH、温度 5–32℃）、③显式授权共同决定。**已售票只作风险提示，绝不自动放行。**
- **最小冻结面**：发现开裂/虫蛀只冻结相关部件，同偶其他部件照常使用；仅结构性断裂（`part_only=false`）才冻结整偶。
- **修复即历史**：每次修复按“层”追加（材料、手法、修缮师），返工不覆盖旧痕迹；修复本身不解冻，须经检验才能恢复使用。
- **替身须核准**：替身是独立的 replica 物件，须核准可顶替的剧目/角色及覆盖部件；排期只给建议，必须显式指派、重新评估后才生效。
- **位置唯一**：一个影偶同一时刻只能有一个当前持有人；在线命令拦截重复出库，离线同步对交接链做语义裁决，防止“同一物件两个当前位置”。
- **资格真实**：学徒分层训练不可跳级，训练记录不授独立资格，须师傅复核才“可独立”；未成年人只能接触 replica 级别道具。

## 目录

| 路径 | 内容 |
| --- | --- |
| `contracts/domain.schema.json` | 事件信封 + 主要事件的条件载荷契约 |
| `src/domain.ts` | 全部事件、载荷、枚举的 TypeScript 类型 |
| `src/aggregates/` | 五个聚合：影偶保全、排演计划、学徒资格、借用、环境 |
| `src/aggregates/offlineSync.js` | 离线账本与批次同步（幂等、分叉检测、借用语义裁决） |
| `src/readModels.js` | 三类角色读模型：损伤溯源、学徒名册、换场看板、当前位置 |
| `src/app.js` | 应用门面：统一命令入口，自动注入跨聚合只读注册中心 |
| `data/sample.json` | 联调样例 |
| `tests/` | 20 个测试，覆盖全部业务规则与端到端巡演场景 |

## 聚合与命令

| 聚合 `aggregate` | 命令 `type` | 可执行角色 |
| --- | --- | --- |
| `puppet` | RegisterPuppet / RegisterPart / ObserveDamage / AddRepairLayer / InspectAndReturn / DeclareSubstitute / DeclarePlayableRole / SetHandlingLevel | 修缮师、负责人、传承人 |
| `plan` | PlanPerformance / SwapPlay / ChangeCasting / AssignOperator / EvaluateClearance / AuthorizeStageUse / AssignSubstitute / CancelPlan | 经理排演；**授权仅负责人/传承人** |
| `loan` | CheckoutLoan / TransferCustody / ReturnLoan | 负责人、经理 |
| `apprentice` | EnrollApprentice / RecordTrainingLevel / PassMasterReview / GrantHandlingPrivilege | 传承人（负责人可登记学徒） |
| `environment` | RecordEnvironment | 不限角色，记录事实 |

## 快速示例

```js
import { Application } from "./src/index.js";

const app = new Application();
const manager = { id: "u-manager", roles: ["performance_manager"] };
const lead    = { id: "u-lead",    roles: ["company_lead"] };

app.send({ aggregate: "plan", type: "EvaluateClearance", plan_id: "p1", item_id: "i1" }, { actor: manager });
// 评估通过也只是“具备条件”，必须再显式授权，售票与否不影响这一步：
app.send({ aggregate: "plan", type: "AuthorizeStageUse", plan_id: "p1", item_id: "i1" }, { actor: lead });
```

离线巡演（设备各自记账，重连后整批对账）：

```js
import { OfflineLedger } from "./src/index.js";

const device = new OfflineLedger("tour-truck-01", new Map()); // 可传入出发时的服务器基线
device.stage({
  aggregateType: "loan_record", aggregateId: "loan-7",
  eventType: "CUSTODY_TRANSFERRED",
  payload: { loan_id: "loan-7", puppet_id: "p-001", from_custodian_id: "甲", to_custodian_id: "乙", handoff_note: "草台侧屋交接" },
});
const result = app.sync(device.pending);
// { applied, skipped(幂等重复), merged(追加性事实重编号), conflicts(借用分叉，被拒并留痕) }
```

## 三类角色能回答的问题（读模型）

- **演出经理** `buildStageBoard`：每个条目的阻断原因、建议替身、授权状态与下一步动作——在不伤害老件的前提下完成换场。
- **修缮师** `buildConservationTrace`：从任一部件的开裂/虫蛀，追到最近一次授权上台（场地、操作者）与此前环境读数；修复层完整可查。
- **传承人** `buildCompetencyRoster`：哪些学徒在操控/制作/修补上已通过师傅复核、具备真实独立能力，谁可以接触老件。
- `buildCustodyMap`：每件影偶唯一的当前位置；两条未结清借用同时存在时显式标 `conflict`。

## 本地检查

```bash
node --test
```
