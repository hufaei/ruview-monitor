import { SensingTab } from "./components/SensingTab.js?v=20260728c";

const container = document.querySelector("#sensing");

if (container) {
  const sensing = new SensingTab(container);
  sensing.init().catch((error) => {
    console.error("[Sensing] 初始化失败", error);
    container.innerHTML = `
      <div class="sensing-loading">
        感知演示暂时无法启动，请刷新页面重试。
      </div>
    `;
  });

  window.addEventListener("pagehide", () => sensing.dispose(), { once: true });
}
