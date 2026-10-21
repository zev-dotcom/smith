#!/usr/bin/env node
/* Swipe-to-reply e2e — headless Chromium via CDP (synthetic events only).
 *
 * Loads the real web client (web/index.html + app.js + styles.css) with the
 * Smith API stubbed in-page (owner threads/agents/feed), opens the stub
 * thread, then synthesizes PointerEvents with pointerType "touch" / "mouse"
 * / "pen" to assert:
 *   1. a touch swipe-right past threshold sets the reply target (chip);
 *   2. a mouse drag does NOT (desktop text selection stays free);
 *   3. a 850ms touch hold sets NO reply target (the 550ms long-press
 *      gesture was removed) and text stays selectable after it;
 *   4. a second pointer's pointerup/pointercancel does NOT end or commit
 *      the tracked swipe early (pointerId guard);
 *   5. bubble text is selectable (computed user-select != none) at rest on
 *      touch, and user-select:none applies only while .swiping.
 *
 * Synthetic PointerEvent dispatch cannot reproduce real-device touch
 * physics (scroll chaining, native callout); it exercises the client's
 * event logic only. No real-device claim.
 *
 * Run: node tests/swipe_reply_e2e.js   (needs /opt/meta-chromium/chrome or
 * CHROME_BIN). Exits non-zero on any failure.
 */
"use strict";
const { spawn } = require("child_process");
const path = require("path");

const WEB = path.join(__dirname, "..", "web");
const CHROME = process.env.CHROME_BIN || "/opt/meta-chromium/chrome";
const PORT = 9333;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (detail ? " — " + detail : "")); }
}

const STUB = `
try { localStorage.setItem("smith.cfg.v1", JSON.stringify({url:"http://stub", token:"t"})); } catch (e) {}
window.fetch = function(url, opts){
  var u = String(url);
  function ok(data){ return Promise.resolve({ ok:true, status:200,
    json:function(){ return Promise.resolve(data); } }); }
  if (u.indexOf("/v1/owner/threads") >= 0)
    return ok([{thread_id:"t1", name:"Test chat", members:[], last_at:"2026-10-05T00:00:00Z"}]);
  if (u.indexOf("/v1/owner/agents") >= 0) return ok([]);
  if (u.indexOf("/v1/owner/feed") >= 0)
    return ok({ messages:[{ id:"m1", from:"koda", type:"note",
      body:"hello world this text must stay copyable",
      created_at:"2026-10-05T00:00:00Z" }], next_cursor:null, working:[] });
  return ok({});
};
`;

async function main() {
  const chrome = spawn(CHROME, [
    "--headless", "--disable-gpu", "--no-sandbox", "--no-proxy-server",
    "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests",
    "--remote-debugging-port=" + PORT, "--remote-allow-origins=*",
    "--window-size=400,800", "file://" + path.join(WEB, "index.html"),
  ], { stdio: "ignore" });

  let ws;
  try {
    // wait for CDP
    let target = null;
    for (let i = 0; i < 50 && !target; i++) {
      try {
        const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
        target = list.find((t) => t.type === "page");
      } catch (e) { /* not up yet */ }
      if (!target) await new Promise((r) => setTimeout(r, 200));
    }
    if (!target) throw new Error("no CDP page target");

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    function send(method, params) {
      const id = ++seq;
      return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); });
    }
    async function evalJs(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
      return r.result && r.result.result ? r.result.result.value : undefined;
    }

    await send("Page.enable");
    await send("Runtime.enable");
    // Emulate a coarse-pointer device so @media (hover:none) applies.
    await send("Emulation.setEmulatedMedia", { media: "", features: [{ name: "hover", value: "none" }, { name: "pointer", value: "coarse" }] });
    await send("Page.addScriptToEvaluateOnNewDocument", { source: STUB });
    await send("Page.reload", { ignoreCache: true });
    // file:// page loaded as the browser's initial URL (no navigate needed;
    // navigating from the error/start page trips local-network checks in
    // this Chromium build).
    await new Promise((r) => setTimeout(r, 800));

    await evalJs(`document.querySelector(".trow").click()`);
    await new Promise((r) => setTimeout(r, 800));
    check("stub thread renders one message row", await evalJs(`!!document.querySelector('.msgrow[data-mid="m1"]')`));

    const geom = await evalJs(`(function(){ var r = document.querySelector('.msgrow .bub').getBoundingClientRect();
      return { x: r.left + 10, y: r.top + r.height / 2 }; })()`);

    async function fire(type, pid, ptype, x) {
      return evalJs(`(function(){
        var bub = document.querySelector('.msgrow .bub');
        var ev = new PointerEvent(${JSON.stringify(type)}, { pointerId: ${pid},
          pointerType: ${JSON.stringify(ptype)}, clientX: ${x}, clientY: ${geom.y},
          bubbles: true, cancelable: true, isPrimary: ${pid} === 1 });
        bub.dispatchEvent(ev); return true; })()`);
    }
    const chipShown = () => evalJs(`!document.getElementById('replyChip').hidden`);
    const rowSwiping = () => evalJs(`document.querySelector('.msgrow').classList.contains('swiping')`);

    // 1. Touch swipe sets the reply target.
    await fire("pointerdown", 1, "touch", geom.x);
    await fire("pointermove", 1, "touch", geom.x + 80);
    check("touch drag activates .swiping", await rowSwiping());
    await fire("pointerup", 1, "touch", geom.x + 80);
    check("touch swipe past threshold sets reply chip", await chipShown());
    await evalJs(`document.getElementById('replyCancel').click()`);
    check("chip clears", !(await chipShown()));

    // 2. Mouse drag does nothing.
    await fire("pointerdown", 2, "mouse", geom.x);
    await fire("pointermove", 2, "mouse", geom.x + 80);
    check("mouse drag does not activate swipe", !(await rowSwiping()));
    await fire("pointerup", 2, "mouse", geom.x + 80);
    check("mouse drag sets no reply target", !(await chipShown()));

    // 3. Long-press removed: a touch hold sets no reply target.
    await fire("pointerdown", 1, "touch", geom.x);
    await new Promise((r) => setTimeout(r, 850));   // past the old 550ms timer
    check("touch hold (850ms) sets no reply target", !(await chipShown()));
    check("touch hold does not activate swipe", !(await rowSwiping()));
    const holdSel = await evalJs(`getComputedStyle(document.querySelector('.msgrow .bub')).userSelect`);
    check("bubble user-select is not none after hold", holdSel !== "none", "got " + holdSel);
    const holdText = await evalJs(`(function(){ var b = document.querySelector('.msgrow .bub');
      var r = document.createRange(); r.selectNodeContents(b);
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      return String(s); })()`);
    check("bubble text selectable after hold", holdText.indexOf("copyable") >= 0, JSON.stringify(holdText));
    await fire("pointerup", 1, "touch", geom.x);
    check("pointerup after idle hold sets no reply target", !(await chipShown()));

    // 4. A second pointer must not end/commit the tracked swipe.
    await fire("pointerdown", 1, "touch", geom.x);
    await fire("pointermove", 1, "touch", geom.x + 70);
    check("tracked swipe active before second pointer", await rowSwiping());
    await fire("pointerup", 9, "touch", geom.x);       // second finger lifts
    check("second pointer up does not end tracked swipe", await rowSwiping());
    check("second pointer up does not commit reply", !(await chipShown()));
    await fire("pointercancel", 9, "touch", geom.x);   // second finger cancels
    check("second pointer cancel does not end tracked swipe", await rowSwiping());
    await fire("pointerup", 1, "touch", geom.x + 70);   // tracked pointer lifts
    check("tracked pointer up commits reply (dx 70 > 56)", await chipShown());
    await evalJs(`document.getElementById('replyCancel').click()`);

    // 5. Selectability: none only while swiping.
    const restSel = await evalJs(`getComputedStyle(document.querySelector('.msgrow .bub')).userSelect`);
    check("bubble user-select is not none at rest on touch", restSel !== "none", "got " + restSel);
    await fire("pointerdown", 1, "touch", geom.x);
    await fire("pointermove", 1, "touch", geom.x + 40);
    const midSel = await evalJs(`getComputedStyle(document.querySelector('.msgrow .bub')).userSelect`);
    check("bubble user-select is none while swiping", midSel === "none", "got " + midSel);
    await fire("pointerup", 1, "touch", geom.x + 40);
    check("short swipe (< 56) sets no reply target", !(await chipShown()));
    const selText = await evalJs(`(function(){ var b = document.querySelector('.msgrow .bub');
      var r = document.createRange(); r.selectNodeContents(b);
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      return String(s); })()`);
    check("bubble text selectable via Selection API at rest", selText.indexOf("copyable") >= 0, JSON.stringify(selText));
  } finally {
    try { if (ws) ws.close(); } catch (e) {}
    chrome.kill("SIGKILL");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("E2E ERROR", e.message); process.exit(2); });
