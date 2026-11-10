import {
  Client,
  FluxerAPIError,
  GatewayError,
  type Message,
  type MessageCreate,
} from "talos-fluxer";
import {
  runCode,
  compileCode,
  languages,
  consumeGlobalLimit,
  globalLimitWaitMs,
  type Output,
} from "./godbolt";
import { checkCooldown, cooldownWaitMs, loadCooldowns } from "./cooldown";
import { logError, logWarn } from "./log";
import {
  counters,
  formatBytes,
  formatDuration,
  snapshot,
  startedAt,
} from "./stats";

//vscode format fucke dit up

const token = process.env.FLUXER_BOT_TOKEN;
if (!token) {
  throw new Error("Set FLUXER_BOT_TOKEN (see .env.example)");
}

const origin = process.env.FLUXER_ORIGIN ?? "https://fluxer.app";
const prefix = process.env.COMMAND_PREFIX ?? "!";
const statusText = process.env.CUSTOM_STATUS_TEXT ?? "compiling code...";
const statusEmoji = process.env.CUSTOM_STATUS_EMOJI ?? "💻";
const reactEmoji = process.env.REACT_EMOJI ?? "⏳";

const client = new Client({ token, origin });

let gatewayLatencyMs: number | null = null;
let reconnects = 0;
let connectedAt: number | null = null;

client.on("ready", ({ user }) => {
  console.log(`Connected as ${user.username}`);
  connectedAt = Date.now();

  // Custom status (max 5 presence changes / 20s, enforced by Talos)
  client.gateway.setPresence({
    status: "online",
    custom_status: {
      text: statusText,
      emoji_name: statusEmoji,
    },
  });
});

client.on("heartbeat", ({ latencyMs }) => {
  gatewayLatencyMs = latencyMs;
});

client.on("reconnect", ({ attempt, delayMs }) => {
  reconnects++;
  logWarn("gateway", `reconnecting (attempt ${attempt}, retry in ${Math.round(delayMs)}ms)`);
});

client.on("close", ({ code, reason }) => {
  logWarn("gateway", `connection closed (code ${code}${reason ? `, ${reason}` : ""})`);
});

client.on("error", (error) => {
  // "Heartbeat ACK timed out" is transient (missed one server heartbeat):
  // talos-fluxer emits this and immediately restarts/reconnects itself
  // (gateway.js startHeartbeat -> restart -> scheduleReconnect), so the
  // bot recovers on its own. Log it as a one-line warning, not a crash.
  if (error instanceof GatewayError && error.message === "Heartbeat ACK timed out") {
    logWarn("gateway", "heartbeat ACK timed out — reconnecting automatically", error);
    return;
  }
  if (error instanceof FluxerAPIError) {
    logError(
      "api request",
      error,
      `${error.method} ${error.route} -> HTTP ${error.status}, code ${error.code ?? "n/a"}`,
    );
  } else {
    logError("gateway/client", error);
  }
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    counters.messages++;

    const content = message.content.trim();

    if (content === `${prefix}ping`) {
      counters.pings++;
      await message.reply({ embeds: [pingEmbed()] });
      return;
    }

    if (content === `${prefix}help`) {
      await message.reply({ embeds: [helpEmbed()] });
      return;
    }

    if (content.startsWith(`${prefix}run`)) {
      counters.runs++;
      const parts = parseFence(content.slice(`${prefix}run`.length), `${prefix}run`);
      if (parts.err) {
        counters.errors++;
        await message.reply({ embeds: [errorEmbed(parts.err)] });
        return;
      }
      if (!(await gateCooldown(message))) return;
      ack(message);
      const out = await runCode(parts.lang, parts.code);
      await message.reply({ embeds: [outputEmbed("run", parts.lang, out)] });
      return;
    }
    if (content.startsWith(`${prefix}compile`)) {
      counters.compiles++;
      const parts = parseFence(content.slice(`${prefix}compile`.length), `${prefix}compile`);
      if (parts.err) {
        counters.errors++;
        await message.reply({ embeds: [errorEmbed(parts.err)] });
        return;
      }
      if (!(await gateCooldown(message))) return;
      ack(message);
      const out = await compileCode(parts.lang, parts.code);
      await message.reply({ embeds: [outputEmbed("compile", parts.lang, out)] });
      return;
    }
  } catch (error) {
    counters.errors++;
    logError("messageCreate", error, `message ${message.id}`);
  }
});

process.on("unhandledRejection", (reason) => {
  logError("unhandledRejection", reason);
});

process.on("uncaughtException", (error) => {
  logError("uncaughtException", error);
});

process.once("SIGINT", () => {
  client.disconnect();
  process.exit(0);
});
process.once("SIGTERM", () => {
  client.disconnect();
  process.exit(0);
});

await loadCooldowns();
await client.connect({ timeoutMs: 30_000 });

interface FencedCode {
  lang: string;
  code: string;
  err: string;
}

function parseFence(raw: string, cmd: string): FencedCode {
  const empty: FencedCode = { lang: "", code: "", err: "" };

  const trimmed = raw.trim();
  if (!trimmed) {
    empty.err = `usage: ${cmd} <lang> followed by a fenced code block, or ${cmd} with a fenced code block containing the language`;
    return empty;
  }

  // Try explicit language first: ${cmd} <lang> ...
  const spaceAt = trimmed.indexOf(" ");
  const newlineAt = trimmed.indexOf("\n");
  let langEnd = trimmed.length;
  if (spaceAt >= 0 && (newlineAt < 0 || spaceAt < newlineAt)) langEnd = spaceAt;
  if (newlineAt >= 0 && newlineAt < langEnd) langEnd = newlineAt;

  const explicitLang = trimmed.slice(0, langEnd).toLowerCase();
  const restAfterExplicit = trimmed.slice(langEnd).trim();

  // If explicit lang is valid, use it and parse code block from rest
  if (languages[explicitLang]) {
    const parsed = extractCodeBlock(restAfterExplicit, explicitLang);
    if (!parsed.err) return parsed;
    // If explicit lang given but code block parsing failed, fall through to infer from fence
  }

  // Fallback: infer language from first fenced code block with a language tag
  const inferred = extractFirstFencedBlock(trimmed);
  if (inferred) return inferred;

  // If explicit lang was given but invalid, report that error
  if (explicitLang && !languages[explicitLang]) {
    empty.err = `unknown language '${explicitLang}'. supported: ${Object.keys(languages).join(", ")}`;
    return empty;
  }

  empty.err = "send code in a ``` fenced block with a language tag (e.g. ```c)";
  return empty;
}

function extractCodeBlock(rest: string, lang: string): FencedCode {
  const empty: FencedCode = { lang: "", code: "", err: "" };

  const fenceStart = rest.indexOf("```");
  if (fenceStart < 0) {
    empty.err = "send code in a ``` fenced block";
    return empty;
  }

  let afterOpen = fenceStart + 3;
  while (afterOpen < rest.length && rest[afterOpen] != "\n") afterOpen++;
  if (afterOpen >= rest.length) {
    empty.err = "code block is not closed";
    return empty;
  }
  afterOpen++;

  const fenceEnd = rest.indexOf("```", afterOpen);
  if (fenceEnd < 0) {
    empty.err = "code block is not closed";
    return empty;
  }

  const code = rest.slice(afterOpen, fenceEnd);
  if (!code.trim()) {
    empty.err = "code block is empty";
    return empty;
  }

  return { lang, code, err: "" };
}

function extractFirstFencedBlock(text: string): FencedCode | null {
  let searchPos = 0;
  while (true) {
    const fenceStart = text.indexOf("```", searchPos);
    if (fenceStart < 0) return null;

    let afterOpen = fenceStart + 3;
    // read language tag (until newline or end)
    let langEnd = afterOpen;
    while (langEnd < text.length && text[langEnd] !== "\n") langEnd++;
    const lang = text.slice(afterOpen, langEnd).trim().toLowerCase();

    if (langEnd >= text.length) {
      searchPos = fenceStart + 3;
      continue;
    }
    afterOpen = langEnd + 1; // skip newline

    const fenceEnd = text.indexOf("```", afterOpen);
    if (fenceEnd < 0) {
      searchPos = fenceStart + 3;
      continue;
    }

    const code = text.slice(afterOpen, fenceEnd);
    if (!code.trim()) {
      searchPos = fenceStart + 3;
      continue;
    }

    if (!languages[lang]) {
      searchPos = fenceStart + 3;
      continue;
    }

    return { lang, code, err: "" };
  }
}

type Embed = NonNullable<MessageCreate["embeds"]>[number];

const COLOR_INFO = 0x5865f2;
const COLOR_OK = 0x57f287;
const COLOR_WARN = 0xfee75c;
const COLOR_ERR = 0xed4245;

function errorEmbed(description: string): Embed {
  return { title: "Error", description, color: COLOR_ERR };
}

function ack(message: Message): void {
  void message.react(reactEmoji).catch((error) => {
    logError("react", error, `message ${message.id}`);
  });
}

// run/compile gates, in order: global "busy" cap, then per-user cooldown.
async function gateCooldown(message: Message): Promise<boolean> {
  const now = Date.now();
  const globalWait = globalLimitWaitMs(now);
  if (globalWait > 0) {
    await message.reply({
      embeds: [
        {
          title: "Server busy",
          description: `Too many requests right now — try again in ${Math.ceil(globalWait / 1000)}s.`,
          color: COLOR_WARN,
        },
      ],
    });
    return false;
  }
  const personalWait = cooldownWaitMs(message.author.id, now);
  if (personalWait > 0) {
    await message.reply({
      embeds: [
        {
          title: "Slow down",
          description: `You can use ${prefix}run / ${prefix}compile again in ${Math.ceil(personalWait / 1000)}s.`,
          color: COLOR_WARN,
        },
      ],
    });
    return false;
  }
  // both clear: spend both budgets (no await between peek and spend,
  // so a concurrent request can't slip in)
  consumeGlobalLimit(now);
  const cd = await checkCooldown(message.author.id, now);
  if (!cd.ok) {
    await message.reply({
      embeds: [
        {
          title: "Slow down",
          description: `You can use ${prefix}run / ${prefix}compile again in ${Math.ceil(cd.retryAfterMs / 1000)}s.`,
          color: COLOR_WARN,
        },
      ],
    });
    return false;
  }
  return true;
}

function pingEmbed(): Embed {
  const s = snapshot();
  const heapPct =
    s.heapTotal > 0 ? Math.round((s.heapUsed / s.heapTotal) * 100) : 0;
  const hostUsed = s.hostTotalMem - s.hostFreeMem;
  const load = s.loadAvg.map((n) => n.toFixed(2)).join(", ");
  const connected =
    connectedAt !== null
      ? `Connected ${formatDuration(Date.now() - connectedAt)} ago`
      : "Not connected";

  return {
    title: "Pong!",
    description: "fluxer-compiler is online",
    color: COLOR_OK,
    fields: [
      {
        name: "Uptime",
        value: `${formatDuration(s.uptimeMs)}\nsince ${new Date(startedAt).toISOString()}`,
      },
      {
        name: "Memory",
        value: `RSS ${formatBytes(s.rss)}\nHeap ${formatBytes(s.heapUsed)} / ${formatBytes(s.heapTotal)} (${heapPct}%)\nExternal ${formatBytes(s.external)}`,
      },
      {
        name: "CPU",
        value: `${(s.cpuUserSec + s.cpuSystemSec).toFixed(1)}s total (user ${s.cpuUserSec.toFixed(1)}s, sys ${s.cpuSystemSec.toFixed(1)}s)\nLoad ${load}`,
      },
      {
        name: "Gateway",
        value: `${client.gateway.state}\n${connected}\nHeartbeat ${gatewayLatencyMs !== null ? `${gatewayLatencyMs} ms` : "n/a"}\nReconnects ${reconnects}`,
      },
      {
        name: "System",
        value: `${s.platform} ${s.arch} · Bun ${s.bunVersion} · pid ${s.pid}\nHost RAM ${formatBytes(hostUsed)} / ${formatBytes(s.hostTotalMem)} used`,
      },
      {
        name: "Usage (since boot)",
        value: `${counters.messages} messages · ${counters.pings} ping · ${counters.runs} run · ${counters.compiles} compile · ${counters.errors} errors`,
      },
    ],
  };
}

// help embed. Language list is derived from `languages` so it stays in sync.
function helpEmbed(): Embed {
  const langs = Object.keys(languages).sort().join(", ");
  return {
    title: "fluxer-compiler",
    description: "Run or compile code from chat, powered by Godbolt.",
    color: COLOR_INFO,
    fields: [
      {
        name: `${prefix}ping`,
        value: "Check if the bot is online — uptime, memory, CPU, gateway latency",
      },
      { name: `${prefix}help`, value: "Show this help" },
      { name: `${prefix}run [lang]`, value: "Run code in a fenced block (lang can be inferred from the fence tag)" },
      { name: `${prefix}compile [lang]`, value: "Compile code in a fenced block (lang can be inferred from the fence tag)" },
      { name: "Languages", value: langs },
      { name: "Cooldown", value: "1 minute between run/compile, per user" },
      { name: "Rate limit", value: "~30 run/compile per minute across everyone" },
      {
        name: "Example",
        value: `${prefix}run\n\`\`\`python\nprint("hello from fluxer-compiler")\n\`\`\``,
      },
      {
        name: "Links",
        value:
          "[Invite](https://fluxer.com/oauth2/authorize?client_id=1568678169844649988&scope=bot&permissions=281664) • [Support server](https://fluxer.gg/s1evrala) • [GitHub](https://github.com/korrykatti/fluxer-compiler)",
      },
    ],
  };
}

// turns run/compile output into an embed
function outputEmbed(kind: string, lang: string, out: Output): Embed {
  const fields: NonNullable<Embed["fields"]> = [];
  // for compile, stdout holds the assembly (see godbolt.ts)
  if (out.stdout)
    fields.push({
      name: kind === "compile" ? "assembly" : "stdout",
      value: codeBlock(out.stdout),
    });
  if (out.stderr) fields.push({ name: "stderr", value: codeBlock(out.stderr) });

  return {
    title: `${kind[0].toUpperCase()}${kind.slice(1)} (${lang})`,
    description: out.err ? out.err : fields.length ? undefined : "(no output)",
    color: out.err ? COLOR_ERR : out.code === 0 ? COLOR_OK : COLOR_WARN,
    fields: fields.length ? fields : undefined,
    footer: out.err ? undefined : { text: `exit: ${out.code}` },
  };
}

function codeBlock(s: string): string {
  return "```\n" + truncate(s) + "\n```";
}

// embed field values are capped at 1024 chars, so stay under that
function truncate(s: string): string {
  const MAX = 980;
  if (s.length <= MAX) return s;
  return s.slice(0, MAX) + "\n... (truncated)";
}
