import { spawn } from "node:child_process";
await import("./build-electron.mjs");
const vite = spawn("npm", ["run", "dev:web"], { stdio: "inherit" });
let desktop;
function stop() {
  vite.kill();
  desktop?.kill();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (let i = 0; i < 100; i++) {
  try {
    await fetch("http://127.0.0.1:5173");
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
const desktopEnv = {
  ...process.env,
  VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
};
delete desktopEnv.ELECTRON_RUN_AS_NODE;
desktop = spawn("electron", ["."], { stdio: "inherit", env: desktopEnv });
desktop.on("exit", () => {
  vite.kill();
  process.exit();
});
