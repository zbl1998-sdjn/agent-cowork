// 可信进程内模型调用 capability(host · L1 领域层 · engine/agent)
// ---------------------------------------------------------------------------
// 职责:把一次进程内调用授权绑定到具体函数对象。品牌只存在于本模块私有 WeakMap，
// JSON/请求对象、类型断言或为另一函数签发的 capability 均不能伪造授权。
import type { ModelCall } from './model-call-types.js';

declare const trustedInProcessModelCallBrand: unique symbol;

export type TrustedInProcessModelCallCapability = Readonly<{
  [trustedInProcessModelCallBrand]: true;
}>;

const trustedBindings = new WeakMap<object, ModelCall>();

/** 仅供可信依赖装配层使用；不得从请求字段或可反序列化配置构造。 */
export function createTrustedInProcessModelCallCapability(
  modelCall: ModelCall,
): TrustedInProcessModelCallCapability {
  if (typeof modelCall !== 'function') {
    throw new TypeError('trusted in-process model capability requires a function');
  }
  const capability = Object.freeze(Object.create(null)) as TrustedInProcessModelCallCapability;
  trustedBindings.set(capability, modelCall);
  return capability;
}

/** Runtime authority check: capability 必须由本模块签发且绑定当前同一函数对象。 */
export function grantsTrustedInProcessModelCall(
  capability: unknown,
  modelCall: ModelCall,
): boolean {
  return Boolean(
    capability
      && typeof capability === 'object'
      && trustedBindings.get(capability) === modelCall,
  );
}
