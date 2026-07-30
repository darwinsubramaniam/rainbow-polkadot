#!/usr/bin/env node
// Local stand-in for the webhook sink, so a harness run shows the same
// breadcrumb stream a deployment would produce.
//
// Prints each stage as it arrives rather than accumulating, because the whole
// value of the webhook channel is watching where a run stops — a summary
// printed at the end would tell you nothing about a job that hangs.

import http from "node:http";

const PORT = Number(process.env.PORT ?? 9000);
const t0 = Date.now();
const at = () => `${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(6)}s`;

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.writeHead(200, {"content-type": "application/json"});
      res.end('{"ok":true}');

      if (req.method !== "POST") return;

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        // A body the sink cannot parse is itself a finding: esc() in start.sh
        // exists precisely to stop a log tail producing one.
        console.log(`${at()}  [unparseable ${body.length}B] ${body.slice(0, 120)}`);
        return;
      }

      // The report goes to its own path and is the deliverable, not a breadcrumb.
      if (req.url !== "/") {
        console.log(`${at()}  REPORT ${req.url} -> ${JSON.stringify(parsed).slice(0, 300)}`);
        return;
      }

      const {stage = "?", detail = "", code, logTail} = parsed;
      const flag = stage.startsWith("FAILED") ? "!!" : stage === "exit" ? "==" : "  ";
      console.log(`${at()} ${flag} ${stage}${code === undefined ? "" : ` code=${code}`}  ${detail}`);
      if (logTail) console.log(`         tail: ${String(logTail).slice(0, 400)}`);
    });
  })
  .listen(PORT, "0.0.0.0", () => console.log(`[sink] listening on :${PORT}`));
