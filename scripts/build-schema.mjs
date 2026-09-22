/**
 * 从 src/contracts.js 的事件目录生成 contracts/domain.schema.json。
 * 运行：node scripts/build-schema.mjs
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { EVENT_CATALOG } from "../src/contracts.js";

function fieldSchema(rule) {
  let base;
  switch (rule.type) {
    case "string":
      base = { type: "string", minLength: 1 };
      if (rule.enum) base.enum = rule.enum;
      break;
    case "number":
      base = { type: "number" };
      if (rule.min !== undefined) base.minimum = rule.min;
      if (rule.max !== undefined) base.maximum = rule.max;
      break;
    case "boolean":
      base = { type: "boolean" };
      break;
    case "array":
      base = {
        type: "array",
        minItems: 1,
        items: rule.itemFields
          ? fieldSchema({ type: "object", fields: rule.itemFields })
          : { type: "string", minLength: 1 },
      };
      break;
    case "object":
      base = payloadSchema(rule.fields);
      break;
    default:
      base = {};
  }
  return base;
}

function payloadSchema(fields) {
  const required = Object.entries(fields)
    .filter(([, rule]) => rule.required)
    .map(([key]) => key);
  const properties = {};
  for (const [key, rule] of Object.entries(fields)) properties[key] = fieldSchema(rule);
  return {
    type: "object",
    required,
    properties,
    additionalProperties: true,
  };
}

const eventTypes = Object.keys(EVENT_CATALOG);
const aggregateTypes = [...new Set(Object.values(EVENT_CATALOG).map((c) => c.aggregate))];

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "皮影古件演出保全领域事件",
  type: "object",
  required: ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"],
  properties: {
    event_id: { type: "string", minLength: 1 },
    event_type: { type: "string", enum: eventTypes },
    aggregate_type: { type: "string", enum: aggregateTypes },
    aggregate_id: { type: "string", minLength: 1 },
    occurred_at: { type: "string", format: "date-time" },
    version: { type: "integer", minimum: 1 },
    summary: { type: "string", minLength: 1 },
    payload: { type: "object" },
    offline: {
      type: "object",
      required: ["client_id", "client_seq"],
      properties: {
        client_id: { type: "string", minLength: 1 },
        client_seq: { type: "integer", minimum: 1 },
        previous_event_id: { type: ["string", "null"], minLength: 1 },
      },
      additionalProperties: false,
    },
  },
  oneOf: eventTypes.map((type) => ({
    properties: {
      event_type: { const: type },
      aggregate_type: { const: EVENT_CATALOG[type].aggregate },
      payload: payloadSchema(EVENT_CATALOG[type].fields),
    },
  })),
  additionalProperties: true,
};

const out = fileURLToPath(new URL("../contracts/domain.schema.json", import.meta.url));
await writeFile(out, JSON.stringify(schema, null, 2) + "\n", "utf8");
console.log(`已生成 ${out}：${eventTypes.length} 类事件`);
