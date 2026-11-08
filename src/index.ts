import { Client, FluxerAPIError } from "talos-fluxer";
import { runCode, compileCode, languages, type Output } from "./godbolt";

const token = process.env.FLUXER_BOT_TOKEN;
if (!token) {
  throw new Error("Set FLUXER_BOT_TOKEN (see .env.example)");
}

const origin = process.env.FLUXER_ORIGIN ?? "https://fluxer.app";
const prefix = process.env.COMMAND_PREFIX ?? "!";
const statusText = process.env.CUSTOM_STATUS_TEXT ?? "compiling code...";
const statusEmoji = process.env.CUSTOM_STATUS_EMOJI ?? "💻";

const client = new Client({ token, origin });

client.on("ready", ({ user }) => {
  console.log(`Connected as ${user.username}`);

  // Custom status (max 5 presence changes / 20s, enforced by Talos)
  client.gateway.setPresence({
    status: "online",
    custom_status: {
      text: statusText,
      emoji_name: statusEmoji,
    },
  });
});

client.on("error", (error) => {
  if (error instanceof FluxerAPIError) {
    console.error(
      "API request failed",
      error.status,
      error.code,
      error.route,
    );
  } else {
    console.error(error);
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();

  if (content === `${prefix}ping`) {
    // Example: plain reply. Swap for an embed when you add /run:
    // await message.reply({
    //   embeds: [{ title: "Pong!", description: "fluxer-compiler is online", color: 0x5865f2 }],
    // });
    await message.reply("Pong!");
    return;
  }

  if (content === `${prefix}help`) {
    await message.reply(`Commands: ${prefix}ping, ${prefix}help`);
  }

  if (content.startsWith(`${prefix}run`)) {
    const parts = parseFence(content.slice(`${prefix}run`.length));
    if (parts.err) {
      await message.reply(parts.err);
      return;
    }
    const out = await runCode(parts.lang, parts.code);
    await message.reply(formatOutput("run", out));
    return;
  }
  if (content.startsWith(`${prefix}compile`)) {
    const parts = parseFence(content.slice(`${prefix}compile`.length));
    if (parts.err) {
      await message.reply(parts.err);
      return;
    }
    const out = await compileCode(parts.lang, parts.code);
    await message.reply(formatOutput("compile", out));
    return;
  }
});

process.once("SIGINT", () => {
  client.disconnect();
  process.exit(0);
});
process.once("SIGTERM", () => {
  client.disconnect();
  process.exit(0);
});

await client.connect({ timeoutMs: 30_000 });

interface FencedCode {
  lang: string;
  code: string;
  err: string;
}

function parseFence(raw: string): FencedCode {
  const empty: FencedCode = { lang: "", code: "", err: "" };

  const trimmed = raw.trim();
  if (!trimmed) {
    empty.err = "usage: /run <lang> then a codeblock";
    return empty;
  }

  // first word is langauge
  const spaceAt = trimmed.indexOf(" ");
  const newlineAt = trimmed.indexOf("\n");
  let langEnd = trimmed.length;
  if (spaceAt >= 0 && (newlineAt < 0 || spaceAt < newlineAt)) langEnd = spaceAt;
  if (newlineAt >= 0 && newlineAt < langEnd) langEnd = newlineAt;

  const lang = trimmed.slice(0, langEnd).toLowerCase();

  if (!languages[lang]) {
    empty.err = `unknown language '${lang}'. supported: ${Object.keys(languages).join(", ")}`;
    return empty;
  }

  const rest = trimmed.slice(langEnd).trim();

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

  return { lang: lang, code: code, err: "" };

}

// turns output into reply string
function formatOutput(kind:string,out:Output):string{
  if (out.err){
    return `**${kind} error:** ${out.err}`;
  }

  const parts: string[] = [];
  if (out.stdout) parts.push("**stdout:**\n```\n"+truncate(out.stdout)+"\n```");
  if (out.stderr) parts.push("**stderr:**\n```\n"+truncate(out.stderr)+"\n```")

  parts.push(`exit: ${out.code}`);

  return parts.join("\n");
}

function truncate(s: string): string {
  const MAX = 1500;
  if (s.length <= MAX) return s;
  return s.slice(0, MAX) + "\n... (truncated)";
}
