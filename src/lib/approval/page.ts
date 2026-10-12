import type { ApprovalRecord } from "./store.js";
import type { DecodedView, ReviewStep } from "./review.js";
import { chainLabel, isMainnet } from "./review.js";

/**
 * ── The approval page ──────────────────────────────────────────────────────
 *
 * Server-rendered, self-contained HTML: no external script, style, font or
 * image (the CSP forbids them), one nonce'd inline style and one nonce'd
 * inline script. Every dynamic value goes through `esc()`; untrusted text
 * (calldata strings, token symbols, the builder's note) was already
 * sanitized and length-capped by review.ts and is labelled as unverified.
 *
 * The password is POSTed with fetch() (not a form): a fetch carries the real
 * `Origin` the server checks even under `Referrer-Policy: no-referrer`, while a
 * form navigation from such a page sends `Origin: null`.
 */

export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#16181d;--muted:#5b6270;--line:#e2e5ea;--danger:#b42318;--danger-bg:#fef3f2;--warn:#93370d;--warn-bg:#fffaeb;--ok:#067647;--ok-bg:#ecfdf3;--accent:#1d4ed8}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--ink:#e8eaee;--muted:#9aa3b2;--line:#2a2f3a;--danger:#fda29b;--danger-bg:#3a1512;--warn:#fec84b;--warn-bg:#33270a;--ok:#75e0a7;--ok-bg:#0b2a1b;--accent:#8ab4ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:0 0 14px}
.grid{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px}.k{color:var(--muted)}
code,.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px;word-break:break-all}
.fp{font-family:ui-monospace,Consolas,monospace;font-size:22px;letter-spacing:2px;font-weight:700}
.badge{display:inline-block;border-radius:999px;padding:1px 10px;font-size:12px;font-weight:600;margin-right:6px}
.b-main{background:var(--danger-bg);color:var(--danger)}.b-test{background:var(--ok-bg);color:var(--ok)}
.risk{border-radius:8px;padding:6px 10px;margin:6px 0;font-size:14px}
.r-danger{background:var(--danger-bg);color:var(--danger);font-weight:600}.r-warn{background:var(--warn-bg);color:var(--warn)}.r-info{color:var(--muted)}
.step h2{font-size:16px;margin:0 0 8px}.args{margin:6px 0 0 0;padding:0;list-style:none}.args li{margin:2px 0}
.nested{border-left:3px solid var(--line);margin:8px 0 0 4px;padding-left:12px}
.note{color:var(--muted);font-size:13px}
label{display:block;font-weight:600;margin:0 0 6px}
input[type=password]{width:100%;font-size:16px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
.actions{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap}
button{font-size:15px;font-weight:600;padding:10px 18px;border-radius:8px;border:1px solid var(--line);cursor:pointer;background:var(--card);color:var(--ink)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button:disabled{opacity:.5;cursor:default}
#msg{margin-top:10px;font-weight:600}.ok{color:var(--ok)}.bad{color:var(--danger)}
`;

function renderDecoded(d: DecodedView): string {
  const args = d.args.length
    ? `<ul class="args">${d.args.map((a) => `<li><span class="k">${esc(a.name)}</span> <code>${esc(a.value)}</code></li>`).join("")}</ul>`
    : "";
  const nested = d.nested.length
    ? `<div class="nested"><div class="note">contains ${d.nested.length} inner call(s):</div>${d.nested
        .map((n) => renderDecoded(n))
        .join("")}</div>`
    : "";
  return `<div><code>${esc(d.contract ? `${d.contract}.` : "")}${esc(d.signature)}</code>${args}${nested}</div>`;
}

function renderStep(s: ReviewStep, total: number): string {
  const risks = s.risks.map((r) => `<div class="risk r-${r.level}">${esc(r.text)}</div>`).join("");
  return `<section class="card step">
<h2>Transaction ${s.index + 1} of ${total}</h2>
<div class="grid">
<div class="k">To</div><div><code>${esc(s.to)}</code><br><span>${esc(s.toLabel)}</span></div>
<div class="k">Value</div><div>${esc(s.valueHuman)}</div>
<div class="k">Call</div><div>${s.decoded ? renderDecoded(s.decoded) : `<span class="bad">not decodable</span> — <code>${esc(s.dataPreview)}</code>`}</div>
<div class="k">Calldata</div><div class="note">${esc(s.dataBytes)} bytes · keccak <code>${esc(s.dataHash)}</code></div>
${s.builderNote ? `<div class="k">Tool's note</div><div class="note">${esc(s.builderNote)} <em>(written by the calling tool — not verified)</em></div>` : ""}
</div>
${risks}
</section>`;
}

export interface PageOptions {
  nonce: string;
  /** Absolute paths the script posts to / polls. */
  approvePath: string;
  declinePath: string;
  statusPath: string;
}

export function renderApprovalPage(r: ApprovalRecord, o: PageOptions): string {
  const mainnet = isMainnet(r.chainId);
  const expiresIn = Math.max(0, Math.round((r.expiresAt - Date.now()) / 60_000));
  const resume = r.resumeNote?.length
    ? `<section class="card"><strong>Earlier in this flow</strong><div class="note">These already landed on-chain before a failure and are NOT part of this approval:</div><ul class="args">${r.resumeNote
        .map((l) => `<li>${esc(l.label)} — <code>${esc(l.txHash)}</code></li>`)
        .join("")}</ul></section>`
    : "";
  const sim =
    r.prechecks.simulation === "pass"
      ? "transaction 1 simulated OK"
      : r.prechecks.simulation === "unavailable"
        ? "simulation unavailable (RPC) — retried at send time"
        : "not simulated";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Approve ${esc(r.steps.length)} transaction(s) — dexe-mcp</title>
<style nonce="${esc(o.nonce)}">${STYLE}</style></head>
<body><main>
<h1>Approve ${esc(r.steps.length)} transaction${r.steps.length === 1 ? "" : "s"}</h1>
<p class="sub">Requested by the <code>${esc(r.tool)}</code> tool of your local dexe-mcp server. Nothing is signed until you enter your keystore password below.</p>
<section class="card"><div class="grid">
<div class="k">Network</div><div><span class="badge ${mainnet ? "b-main" : "b-test"}">${mainnet ? "MAINNET" : "testnet"}</span>${esc(chainLabel(r.chainId))}</div>
<div class="k">From</div><div><code>${esc(r.from)}</code></div>
<div class="k">Fingerprint</div><div><span class="fp">${esc(r.fingerprint)}</span><div class="note">The tool reported the same code in your chat. If they differ, decline.</div></div>
<div class="k">Checks</div><div>allowlist / value cap / wrong-chain / denylist passed · ${esc(sim)}${r.prechecks.simulationNote ? `<div class="note">${esc(r.prechecks.simulationNote)}</div>` : ""}</div>
<div class="k">Expires</div><div>in about ${esc(expiresIn)} min</div>
</div></section>
${resume}
${r.steps.map((s) => renderStep(s, r.steps.length)).join("\n")}
<section class="card" id="decide">
<label for="pw">Keystore password</label>
<input id="pw" type="password" autocomplete="off" spellcheck="false" maxlength="1024">
<p class="note">Type it here only — never in the chat. It unlocks the key once, for exactly these transactions, and is not stored. Do not let your browser save it.</p>
<div class="actions"><button id="approve" class="primary">Approve and sign</button><button id="decline">Decline</button></div>
<div id="msg" role="status"></div>
</section>
</main>
<script nonce="${esc(o.nonce)}">
(function(){
var csrf=${JSON.stringify(r.csrf)};
var ap=${JSON.stringify(o.approvePath)},dp=${JSON.stringify(o.declinePath)},sp=${JSON.stringify(o.statusPath)};
var msg=document.getElementById("msg"),pw=document.getElementById("pw"),a=document.getElementById("approve"),d=document.getElementById("decline");
function say(t,ok){msg.textContent=t;msg.className=ok?"ok":"bad";}
function busy(b){a.disabled=b;d.disabled=b;pw.disabled=b;}
function post(path,body){return fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),credentials:"same-origin",cache:"no-store",referrerPolicy:"no-referrer"}).then(function(r){return r.json().then(function(j){j.httpStatus=r.status;return j;});});}
function poll(){fetch(sp,{cache:"no-store"}).then(function(r){return r.json();}).then(function(s){
 var t="Status: "+s.status+(s.landed&&s.landed.length?" — sent: "+s.landed.map(function(l){return "#"+(l.index+1)+" "+l.txHash;}).join(", "):"");
 say(t,s.status!=="revoked"&&s.status!=="declined"&&s.status!=="expired");
 if(s.status==="approved"||s.status==="executing")setTimeout(poll,1500);
}).catch(function(){setTimeout(poll,3000);});}
a.addEventListener("click",function(){
 if(!pw.value){say("Enter the keystore password.",false);return;}
 busy(true);say("Checking the password (about a second)…",true);
 post(ap,{csrf:csrf,password:pw.value,webdriver:navigator.webdriver===true}).then(function(j){
  pw.value="";
  if(j.status==="approved"){say(j.message,true);poll();}
  else{say(j.message||"Refused.",false);busy(j.status==="declined");}
 }).catch(function(){busy(false);say("Could not reach the local server.",false);});
});
d.addEventListener("click",function(){busy(true);post(dp,{csrf:csrf}).then(function(j){say(j.message||"Declined.",false);}).catch(function(){busy(false);});});
pw.addEventListener("keydown",function(e){if(e.key==="Enter")a.click();});
})();
</script>
</body></html>`;
}

/** Page for an approval that is no longer pending (decided, expired) — no form. */
export function renderClosedPage(r: ApprovalRecord, nonce: string): string {
  const landed = r.landed.length
    ? `<ul class="args">${r.landed.map((l) => `<li>#${l.index + 1} <code>${esc(l.txHash)}</code></li>`).join("")}</ul>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Approval ${esc(r.status)} — dexe-mcp</title><style nonce="${esc(nonce)}">${STYLE}</style></head>
<body><main><h1>This approval is ${esc(r.status)}</h1>
<section class="card"><div class="grid"><div class="k">Fingerprint</div><div class="fp">${esc(r.fingerprint)}</div>
<div class="k">Network</div><div>${esc(chainLabel(r.chainId))}</div>
${r.reason ? `<div class="k">Reason</div><div>${esc(r.reason)}</div>` : ""}</div>${landed}</section>
<p class="note">Nothing more can be approved on this page. You can close it.</p></main></body></html>`;
}

export function renderNotFoundPage(nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not found — dexe-mcp</title><style nonce="${esc(nonce)}">${STYLE}</style></head>
<body><main><h1>No such approval</h1><p class="sub">The link is wrong, or the server restarted and forgot it. Re-run the tool call to get a new link.</p></main></body></html>`;
}
