import { Application } from "../src/index.js";

export const ACTORS = {
  lead: { id: "u-lead", name: "负责人", roles: ["company_lead"] },
  manager: { id: "u-manager", name: "演出经理", roles: ["performance_manager"] },
  conservator: { id: "u-conservator", name: "修缮师", roles: ["conservator"] },
  master: { id: "u-master", name: "传承人", roles: ["inheritor"] },
  apprentice: { id: "u-apprentice", name: "学徒本人", roles: ["apprentice"] },
};

export function newApp() {
  return new Application();
}

/** 登记一件带部件的老件（或复制品）。 */
export function registerPuppet(app, actor, { puppet_id, name, artifact_class = "antique", dating, parts = [] }) {
  app.send(
    { aggregate: "puppet", type: "RegisterPuppet", puppet_id, name, artifact_class, dating },
    { actor },
  );
  for (const part of parts) {
    app.send(
      {
        aggregate: "puppet",
        type: "RegisterPart",
        puppet_id,
        part_id: part.part_id,
        name: part.name,
        initial_status: part.initial_status,
      },
      { actor },
    );
  }
}

/** 断言某命令以指定 code 失败。 */
export function assertRejects(fn, code) {
  let thrown = null;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  if (!thrown) throw new Error(`期望抛出 ${code}，但未抛错`);
  if (thrown.code !== code) throw new Error(`期望错误码 ${code}，实际 ${thrown.code}：${thrown.message}`);
  return thrown;
}
