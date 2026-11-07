import { Client, FluxerAPIError } from "talos-fluxer";

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
