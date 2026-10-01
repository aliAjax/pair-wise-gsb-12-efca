import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer, type ViteDevServer } from "vite";
import { createSSRApp, type Component } from "vue";
import { renderToString } from "@vue/server-renderer";

// ---- SSR 环境的最小 DOM 桩 ----
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "http://localhost/"
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  localStorage: dom.window.localStorage,
  Blob: dom.window.Blob,
  URL: dom.window.URL
});

type StoreModule = typeof import("../src/store/dispatch");
type DispatchStore = ReturnType<StoreModule["useDispatchStore"]>;

async function renderViews(setup: (store: DispatchStore) => void) {
  const vite = await createServer({
    server: { middlewareMode: true },
    logLevel: "error",
    appType: "custom"
  });
  try {
    // pinia 也走 ssr 加载，保证 store 与 app 拿到同一个模块实例
    const piniaModule = (await vite.ssrLoadModule("pinia")) as typeof import("pinia");
    const storeModule = (await vite.ssrLoadModule("/src/store/dispatch.ts")) as StoreModule;
    const modulePaths = [
      ["console", "/src/components/DispatchConsole.vue"],
      ["review", "/src/components/ReviewPanel.vue"],
      ["export", "/src/components/ExportSummary.vue"]
    ] as const;
    const modules: Record<string, Component> = {};
    for (const [name, path] of modulePaths) {
      const mod = (await vite.ssrLoadModule(path)) as { default: Component };
      modules[name] = mod.default;
    }

    const pinia = piniaModule.createPinia();
    piniaModule.setActivePinia(pinia);
    const store = storeModule.useDispatchStore();
    setup(store);

    const out: Record<string, string> = {};
    for (const [name, component] of Object.entries(modules)) {
      const app = createSSRApp(component);
      app.use(pinia);
      out[name] = await renderToString(app);
    }
    return out;
  } finally {
    await (vite as ViteDevServer).close();
  }
}

test("三视图渲染冒烟：演示数据下列出有效/排队/待核对与核对动作", async () => {
  const html = await renderViews((store) => store.loadDemoScenario());

  // 调度台：合并结果表与演示车辆
  assert.match(html.console, /合并结果/);
  assert.match(html.console, /沪A-82L6/);
  assert.match(html.console, /待核对/);

  // 核对区：冲突卡片、批次重试信息
  assert.match(html.review, /核对区/);
  assert.match(html.review, /待核对/);
  assert.match(html.review, /本地批次与重试/);

  // 导出摘要：统计卡片、区域表、导出入口
  assert.match(html.export, /导出摘要/);
  assert.match(html.export, /城北/);
  assert.match(html.export, /导出明细 CSV/);
});

test("空数据三视图也能正常渲染", async () => {
  const html = await renderViews((store) => store.resetAll());
  assert.match(html.console, /合并结果/);
  assert.match(html.review, /没有待核对记录/);
  assert.match(html.export, /导出摘要/);
});
