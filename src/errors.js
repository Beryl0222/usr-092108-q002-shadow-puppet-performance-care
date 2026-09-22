/** 领域规则被违反时抛出（业务拒绝，而不是程序故障）。 */
export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

/** 事件契约不合法（信封或负载字段不符合约定）。 */
export class ContractError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ContractError";
    this.details = details;
  }
}
