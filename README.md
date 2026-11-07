# fluxer-compiler

Fluxer compiler bot -  **Bun + [Talos](https://github.com/tinsever/talos)**.

[invite here](https://fluxer.com/oauth2/authorize?client_id=1568678169844649988&scope=bot&permissions=281664) | [support server](https://fluxer.gg/s1evrala)


## Setup (local)

```sh
cp .env.example .env   # then set FLUXER_BOT_TOKEN=...
bun install
bun run src/index.ts   # or: bun run dev  (watch mode)
```

Try `c!ping` / `c!help` in a channel the bot can read + send in. It replies `Pong!`.

## Setup (Docker)

```sh
cp .env.example .env   # then set FLUXER_BOT_TOKEN=...
docker compose up --build -d
docker compose logs -f
docker compose down
```
