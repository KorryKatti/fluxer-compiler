# fluxer-compiler

A Fluxer bot for compiling code. Run `c!help` in chat for the full list of commands.

[invite here](https://fluxer.com/oauth2/authorize?client_id=1568678169844649988&scope=bot&permissions=281664) | [support server](https://fluxer.gg/s1evrala)

## Setup (local)

```sh
cp .env.example .env   # then set FLUXER_BOT_TOKEN=...
bun install
bun run src/index.ts   # or: bun run dev  (watch mode)
```

## Setup (Docker)

```sh
cp .env.example .env   # then set FLUXER_BOT_TOKEN=...
docker compose up --build -d
docker compose logs -f
docker compose down
```
