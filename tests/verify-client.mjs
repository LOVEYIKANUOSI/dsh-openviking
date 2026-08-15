/**
 * 浏览器半侧模拟验证：在 Node 里模拟 window.__ModuleLoader__ 环境，
 * 执行 client.js 的 factory 并驱动 apply()，确认注册链路不抛错。
 * 组件渲染本身由浏览器负责（本测试不渲染 React 树）。
 */

let definition = null;
globalThis.window = {
  __ModuleLoader__: {
    load: (def) => {
      definition = def;
    },
  },
};

await import("../lib/client.js");

if (!definition) {
  console.error("FAIL: factory 未注册（window.__ModuleLoader__.load 未被调用）");
  process.exit(1);
}
console.log(`[1] factory 已注册, id=${definition.id}`);

// 最小 React 桩（仅验证组件树构造调用，不实际渲染）。
const ReactStub = {
  Component: class {},
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
};

const requireMock = (spec) => {
  if (spec === "react") return ReactStub;
  throw new Error(`unexpected require: ${spec}`);
};
const exported = definition.factory(requireMock);
console.log(`[2] exports: inject=[${exported.inject}] NS=${exported.NS} apply=${typeof exported.apply}`);

let registeredTab = null;
const ctx = {
  effect: (fn) => fn(),
  locale: {
    register: () => {},
    bind: (ns) => (key) => key,
  },
  slots: {
    inject: (name, callback) => {
      console.log(`[3] slots.inject("${name}")`);
      callback();
    },
    register: (options, component) => {
      registeredTab = { options, component };
    },
  },
};
exported.apply(ctx);

if (!registeredTab) {
  console.error("FAIL: settings.plugins.tab 未注册");
  process.exit(1);
}
console.log(`[4] tab 已注册: id=${registeredTab.options.id} order=${registeredTab.options.order} label=${String(registeredTab.options.label())} component=${typeof registeredTab.component}`);
console.log("[done] client bundle apply 链路验证通过");
