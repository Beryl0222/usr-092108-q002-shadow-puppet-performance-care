/** 业务规则被违反时抛出；消息为中文，可直接展示给业务人员。 */
export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

/** 事件信封本身不合法（缺字段、版本号非法等）。 */
export class ContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContractError";
  }
}

/** 离线/并发写入检测到版本分叉。 */
export class ConcurrencyError extends Error {
  constructor(message, conflict) {
    super(message);
    this.name = "ConcurrencyError";
    this.conflict = conflict;
  }
}
