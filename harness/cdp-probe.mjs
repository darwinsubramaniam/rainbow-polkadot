// Drive Chrome over CDP to read the E0.1 probe result.
//
// The dev-dot.li gateway serves Parity's loader shell; the Product itself is
// resolved client-side (DotNS -> CID -> Bulletin -> service worker VFS) and run
// in a sandboxed iframe. So the only way to observe the probe is a real engine
// executing the real load path. Raw CDP avoids installing a browser stack.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_TO_PROBE = process.argv[2] ?? "https://rainbowprobe.dev-dot.li";
const WAIT_MS = Number(process.argv[3] ?? 60000);
const PORT = 9333;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const profile = mkdtempSync(join(tmpdir(), "rainbow-cdp-"));
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    // NOT headless. The gateway resolves the bundle through an in-browser
    // smoldot light client that peers over WebRTC; headless Chrome cannot do
    // that and smoldot panics with "No Bitswap peers connected". Measured, not
    // assumed — the headless run failed exactly this way.
    ...(process.env.PROBE_HEADLESS === "1" ? ["--headless=new"] : ["--window-size=900,1000"]),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    // Service workers and WASM must behave normally; do not weaken security
    // flags here or the probe would be measuring the wrong browser.
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error("Chrome did not expose a CDP endpoint");
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  });
  return {
    send(method, params = {}, sessionId) {
      const m = { id: ++id, method, params };
      if (sessionId) m.sessionId = sessionId;
      ws.send(JSON.stringify(m));
      return new Promise((resolve, reject) => pending.set(m.id, { resolve, reject }));
    },
    on(fn) {
      listeners.push(fn);
    },
  };
}

const main = async () => {
  const wsUrl = await findTarget();
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const c = cdp(ws);

  let result = null;
  const logs = [];

  // Auto-attach to every target, including the sandboxed iframe the Product
  // actually runs in — that is where the probe's console output originates.
  c.on(async (msg) => {
    if (msg.method === "Target.attachedToTarget") {
      const sid = msg.params.sessionId;
      try {
        await c.send("Runtime.enable", {}, sid);
        await c.send("Log.enable", {}, sid);
      } catch {}
    }
    if (msg.method === "Runtime.consoleAPICalled") {
      const args = msg.params.args ?? [];
      const text = args.map((a) => a.value ?? a.description ?? "").join(" ");
      if (text) logs.push(text.slice(0, 200));
      const tagged = args[0]?.value === "[rainbow-probe]";
      if (tagged && args[1]) {
        // Prefer the structured object; fall back to re-reading it by handle.
        if (args[1].preview || args[1].objectId) {
          try {
            const r = await c.send(
              "Runtime.callFunctionOn",
              {
                objectId: args[1].objectId,
                functionDeclaration: "function(){return JSON.stringify(this)}",
                returnByValue: true,
              },
              msg.sessionId,
            );
            result = JSON.parse(r.result.value);
          } catch {}
        }
      }
    }
  });

  await c.send("Target.setDiscoverTargets", { discover: true });
  await c.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });

  const { targetInfos } = await c.send("Target.getTargets");
  const page = targetInfos.find((t) => t.type === "page");
  const { sessionId } = await c.send("Target.attachToTarget", {
    targetId: page.targetId,
    flatten: true,
  });
  await c.send("Runtime.enable", {}, sessionId);
  await c.send("Page.enable", {}, sessionId);
  await c.send("Page.navigate", { url: URL_TO_PROBE }, sessionId);

  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline && !result) await sleep(500);

  // Fallback: scrape the rendered <pre> out of whichever frame has it.
  if (!result) {
    const { targetInfos: all } = await c.send("Target.getTargets");
    for (const t of all.filter((t) => t.type === "iframe" || t.type === "page")) {
      try {
        const { sessionId: sid } = await c.send("Target.attachToTarget", {
          targetId: t.targetId,
          flatten: true,
        });
        await c.send("Runtime.enable", {}, sid);
        const r = await c.send(
          "Runtime.evaluate",
          {
            expression: `(()=>{const p=document.querySelector('pre');return p?p.textContent:null})()`,
            returnByValue: true,
          },
          sid,
        );
        if (r.result?.value) {
          result = JSON.parse(r.result.value);
          break;
        }
      } catch {}
    }
  }

  console.log(JSON.stringify({ url: URL_TO_PROBE, result, consoleTail: logs.slice(-25) }, null, 2));
  ws.close();
};

main()
  .catch((e) => {
    console.error("CDP probe failed:", e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    chrome.kill();
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  });
