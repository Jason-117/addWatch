const kv = await Deno.openKv();

const env = (k: string) => Deno.env.get(k) ?? "";

function jsonEnv<T>(k: string, fallback: T): T {
  const v = env(k);
  if (!v) return fallback;
  try {
    return JSON.parse(v);
  } catch (e) {
    console.log(`[环境变量 ${k} 不是合法 JSON] ${e}`);
    return fallback;
  }
}

// 监控地址
const ADDRESSES_GROUP = jsonEnv<Record<string, string[]>>("ADDRESSES_GROUP", {});
const LABELS = new Map<string, string>();
for (const [label, addrs] of Object.entries(ADDRESSES_GROUP)) {
  for (const a of addrs) LABELS.set(a, label);
}
const WATCH_ADDRESSES = [...LABELS.keys()];
if (!WATCH_ADDRESSES.length) console.log("请先设置环境变量 ADDRESSES_GROUP");

const TRONSCAN_API_KEY = env("TRONSCAN_API_KEY");

// 订单详情接口（用户名，处理时间）
const ORDER_URL = env("ORDER_URL");
const ORDER_PARAMS = jsonEnv<Record<string, string>>("ORDER_PARAMS", {});
const ORDER_HEADERS = jsonEnv<Record<string, string>>("ORDER_HEADERS", {});


const ORDER_NAME_REGEX = new RegExp(env("ORDER_NAME_REGEX") || "用户名[：:]\\s*(\\S+)");
const ORDER_TIME_REGEX = new RegExp(env("ORDER_TIME_REGEX") || "时间[：:]\\s*(\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}:\\d{2})");

const TELEGRAM_BOT_TOKEN = env("TG_BOT_TOKEN");
const TELEGRAM_CHAT_IDS = env("TG_CHAT_IDS").split(",").map((s) => s.trim()).filter(Boolean);
const IMPORT_TOKEN = env("IMPORT_TOKEN");

const OFFICIAL_USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const OVERLAP_MS = 10 * 60 * 1000;
const MAX_PENDING_TRIES = 5;
const SEEN_TTL = 3 * 24 * 3600 * 1000;

interface Tx {
  id: string;
  from: string;
  to: string;
  value: string;
  symbol: string;
  decimals: number;
  contract: string;
  eventType: string;
  approvalAmount: string;
  method: string;
  ts: number | null;
}
interface Order {
  name: string;
  time: string | null;
}
interface Pending {
  tx: Tx;
  addr: string;
  tries: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const has = async (key: Deno.KvKey) => (await kv.get(key)).versionstamp !== null;

const esc = (s: unknown) =>
  String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function fmtTs(ms: unknown): string | null {
  const n = Number(ms);
  if (!n) return null;
  return new Date(n + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function amountStr(raw: string, dec: number): string | null {
  try {
    const s = BigInt(raw).toString().padStart(dec + 1, "0");
    const i = s.slice(0, s.length - dec);
    const f = s.slice(s.length - dec).replace(/0+$/, "");
    return f ? `${i}.${f}` : i;
  } catch {
    return null;
  }
}

function normalize(t: any): Tx {
  const ti = t.tokenInfo ?? {};
  const tr = t.trigger_info ?? {};
  return {
    id: t.transaction_id ?? "?",
    from: t.from_address ?? "?",
    to: t.to_address ?? "?",
    value: String(t.quant ?? "0"),
    symbol: ti.tokenAbbr ?? "",
    decimals: Number(ti.tokenDecimal ?? 6),
    contract: t.contract_address ?? "",
    eventType: t.event_type ?? "Transfer",
    approvalAmount: String(t.approval_amount ?? "0"),
    method: tr.methodName ?? tr.method_name ?? tr.method ?? "",
    ts: t.block_ts ?? null,
  };
}

// 异常
function isAuthorized(tx: Tx): boolean {
  const e = (tx.eventType || "Transfer").trim().toLowerCase();
  const ap = (tx.approvalAmount || "0").trim();
  return e !== "transfer" || !["0", "", "0.0"].includes(ap) ||
    tx.method.trim().toLowerCase() === "transferfrom";
}

function checkAnomalies(tx: Tx): string[] {
  const a: string[] = [];
  if (tx.symbol !== "USDT") {
    a.push(`Token 符号异常：显示为「${tx.symbol}」，并非标准USDT，请高度警惕仿冒代币`);
  }
  if (tx.contract && tx.contract !== OFFICIAL_USDT_TRC20_CONTRACT) {
    a.push(
      `合约地址异常：${tx.contract} 不是官方 USDT-TRC20 合约地址` +
      `（官方地址应为 ${OFFICIAL_USDT_TRC20_CONTRACT}），很可能是仿冒代币`,
    );
  }
  let raw: bigint | null = null;
  try {
    raw = BigInt(tx.value);
  } catch {
    a.push(`金额解析异常：原始数值「${tx.value}」无法正常解析`);
  }
  if (raw !== null) {
    const amt = amountStr(tx.value, tx.decimals);
    if (raw % 10n ** BigInt(tx.decimals) === 0n) {
      a.push(`金额异常：${amt}为整数，可能需要手动核实`);
    } else if (tx.decimals > 2 && raw % 10n ** BigInt(tx.decimals - 2) !== 0n) {
      a.push(`金额异常：${amt}不是标准的两位小数`);
    }
  }
  if (isAuthorized(tx)) a.push(`${tx.from}此次转账为授权转账，请注意核实`);
  return a;
}

function officialRisk(info: any): string[] {
  const a: string[] = [];
  if (!info) return a;
  if (info.riskTransaction) a.push("此次交易涉及风险交易，请仔细核实");
  if (info.cheat_status != null && info.cheat_status !== 0) {
    a.push("此次交易涉及欺诈交易，请仔细核实");
  }
  for (const [addr, v] of Object.entries<any>(info.normalAddressInfo ?? {})) {
    if (v && typeof v === "object" && v.risk) {
      a.push(`地址 ${addr} 被官方标记为风险地址，请仔细核实`);
    }
  }
  for (const [addr, v] of Object.entries<any>(info.contractInfo ?? {})) {
    if (!v || typeof v !== "object") continue;
    if (v.risk) {
      a.push(`地址 ${addr} 风险标签：${typeof v.risk === "string" ? v.risk : "是"}`);
    }
  }
  return a;
}

const tsHeaders = (): HeadersInit =>
  TRONSCAN_API_KEY ? { "TRON-PRO-API-KEY": TRONSCAN_API_KEY } : {};

async function tsFetch(url: string | URL, tries = 3): Promise<Response> {
  for (let i = 1; ; i++) {
    const r = await fetch(url, { headers: tsHeaders(), signal: AbortSignal.timeout(15000) });
    if (r.status !== 429 || i >= tries) return r;
    await r.body?.cancel();
    const ra = Number(r.headers.get("retry-after"));
    const wait = Math.min(ra > 0 ? ra * 1000 : 1000 * 2 ** i, 10000);
    console.log(`[TronScan 429] ${wait}ms 后重试 (${i}/${tries})`);
    await sleep(wait);
  }
}

async function fetchInfo(id: string): Promise<any> {
  try {
    const r = await tsFetch(
      `https://apilist.tronscanapi.com/api/transaction-info?hash=${id}`,
    );
    return r.ok ? (await r.json()) ?? {} : {};
  } catch (e) {
    console.log(`[官方风险信息查询失败] ${id}: ${e}`);
    return {};
  }
}

async function fetchTransfers(addr: string, startTs: number): Promise<Tx[]> {
  const u = new URL("https://apilist.tronscanapi.com/api/token_trc20/transfers");
  u.search = new URLSearchParams({
    limit: "50",
    start: "0",
    sort: "-timestamp",
    relatedAddress: addr,
    start_timestamp: String(startTs),
  }).toString();
  const r = await tsFetch(u);
  if (!r.ok) throw new Error(`tronscan transfers ${r.status}`);
  const data = await r.json();
  return (data.token_transfers ?? []).map(normalize);
}

async function lookupOrder(id: string): Promise<Order | null> {
  if (!ORDER_URL) return null;
  try {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(ORDER_PARAMS)) {
      params.set(k, String(v).replaceAll("{tx}", id));
    }
    const sep = ORDER_URL.includes("?") ? "&" : "?";
    const r = await fetch(`${ORDER_URL}${sep}${params}`, {
      headers: ORDER_HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    const buf = await r.arrayBuffer();
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      text = new TextDecoder("gbk").decode(buf);
    }
    const name = text.match(ORDER_NAME_REGEX)?.[1];
    const time = text.match(ORDER_TIME_REGEX)?.[1] ?? null;
    return name ? { name, time } : null;
  } catch (e) {
    return null;
  }
}

const redact = (s: unknown) =>
  TELEGRAM_BOT_TOKEN ? String(s).replaceAll(TELEGRAM_BOT_TOKEN, "***") : String(s);

// text 必须是已转义好的 HTML；txId 用于生成"查看交易详情"按钮
async function sendTelegramOne(chatId: string, text: string, txId?: string) {
  for (let i = 1; i <= 3; i++) {
    try {
      const payload: Record<string, unknown> = {
        chat_id: chatId,
        text,
        link_preview_options: { is_disabled: true },
        parse_mode: "HTML",
      };
      if (txId) {
        payload.reply_markup = {
          inline_keyboard: [
            [
              {
                text: "查看交易详情",
                url: `https://tronscan.org/#/transaction/${txId}`,
              },
            ],
          ],
        };
      }
      const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) return;
      const j = await r.json().catch(() => ({}));
      throw Object.assign(new Error(`${r.status} ${JSON.stringify(j)}`), {
        wait: (j?.parameters?.retry_after ?? 0) * 1000,
        fatal: r.status >= 400 && r.status < 500 && r.status !== 429,
      });
    } catch (e) {
      console.log(`[Telegram ${chatId} 第 ${i}/3 次失败] ${redact(e)}`);
      if (i === 3 || (e as { fatal?: boolean }).fatal) throw new Error(redact(e));
      await sleep(Math.min((e as { wait?: number }).wait || 2000, 10000));
    }
  }
}

async function sendMail(title: string, body: string, txId?: string) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_IDS.length) return;
  const text = (title ? `${title}\n\n${body}` : body).slice(0, 4000);
  const results = await Promise.allSettled(
    TELEGRAM_CHAT_IDS.map((id) => sendTelegramOne(id, text, txId)),
  );
  if (results.every((r) => r.status === "rejected")) {
    throw new Error("所有 Telegram 收件对象都发送失败");
  }
}

async function notify(tx: Tx, watch: string, order: Order | null) {
  const info = await fetchInfo(tx.id);
  const anomalies = [...officialRisk(info), ...checkAnomalies(tx)];
  const trcTime = fmtTs(tx.ts) ?? fmtTs(info?.timestamp);
  const incoming = tx.to === watch;
  const isFirstPayment = incoming && !(await has(["sender", watch, tx.from]));
  const name = order?.name ?? null;
  const isNewUser = !!name && !(await has(["user", name]));

  const lines: string[] = [];
  if (anomalies.length) {
    lines.push("检测到以下异常，请仔细核实，谨防诈骗：", ...anomalies.map(esc), "");
  }
  lines.push(
    `<b>${esc(LABELS.get(watch) ?? "非监控地址")}</b>`,
    isNewUser ? `用户名：${esc(name)}  新用户` : `用户名：${esc(name)}`,
    `金额：${esc(amountStr(tx.value, tx.decimals) ?? tx.value)} ${esc(tx.symbol || "TOKEN")}`,
    `系统处理时间：${esc(order?.time ?? null)}`,
    isFirstPayment ? `From：<code>${esc(tx.from)}</code>  首次付款` : `From：<code>${esc(tx.from)}</code>`,
    `To：<code>${esc(tx.to)}</code>`,
    `交易哈希：<code>${esc(tx.id)}</code>`,
    `转账时间： ${esc(trcTime)}`,
  );
  const title = anomalies.length ? "异常交易提醒" : "";
  const body = lines.join("\n");

  await sendMail(title, body, tx.id);

  const op = kv.atomic();
  if (name && isNewUser) op.set(["user", name], 1);
  if (incoming && isFirstPayment) op.set(["sender", watch, tx.from], 1);
  await op.commit();
}

async function pollAddress(addr: string) {
  const cur = (await kv.get<number>(["cursor", addr])).value;
  if (cur == null) {
    await kv.set(["cursor", addr], Date.now());
    return;
  }

  const txs = await fetchTransfers(addr, cur - OVERLAP_MS);
  if (!txs.length) return;

  const seenFlags = await Promise.all(txs.map((t) => has(["seen", t.id])));
  const fresh = txs.filter((_, i) => !seenFlags[i]).reverse();

  for (const tx of fresh) {
    // 支出（From 为监控地址）不处理
    if (tx.from === addr) {
      await kv.set(["seen", tx.id], 1, { expireIn: SEEN_TTL });
      continue;
    }
    const anomalous = checkAnomalies(tx).length > 0;
    const order = await lookupOrder(tx.id);

    if (order || anomalous) {
      await notify(tx, addr, order);
    } else {
      await kv.set(["pending", tx.id], { tx, addr, tries: 1 } as Pending, {
        expireIn: 3600 * 1000,
      });
    }
    await kv.set(["seen", tx.id], 1, { expireIn: SEEN_TTL });
  }

  const maxTs = Math.max(cur, ...txs.map((t) => t.ts ?? 0));
  if (maxTs > cur) await kv.set(["cursor", addr], maxTs);
}

async function processPending() {
  for await (const e of kv.list<Pending>({ prefix: ["pending"] })) {
    const p = e.value;
    const order = await lookupOrder(p.tx.id);
    if (order || p.tries >= MAX_PENDING_TRIES) {
      await notify(p.tx, p.addr, order);
      await kv.delete(e.key);
    } else {
      await kv.set(e.key, { ...p, tries: p.tries + 1 }, { expireIn: 3600 * 1000 });
    }
  }
}

Deno.cron("poll-tronscan", "* * * * *", async () => {
  try {
    await processPending();
  } catch (e) {
    console.log(`[pending 出错] ${e}`);
  }
  for (const addr of WATCH_ADDRESSES) {
    try {
      await pollAddress(addr);
    } catch (e) {
      console.log(`[${addr} 本轮出错] ${e}`);
    }
    await sleep(300);
  }
});

// 旧数据导入
Deno.serve(async (req) => {
  const u = new URL(req.url);
  if (
    req.method === "POST" && u.pathname === "/import" && IMPORT_TOKEN &&
    u.searchParams.get("token") === IMPORT_TOKEN
  ) {
    const { users = [], senders = {} } = await req.json();
    for (const n of users as string[]) await kv.set(["user", n], 1);
    for (const [addr, list] of Object.entries(senders as Record<string, string[]>)) {
      for (const s of list) await kv.set(["sender", addr, s], 1);
    }
    return new Response("imported");
  }
  return new Response("ok");
});
