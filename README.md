# makefun-github-core-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/laoyalaoliu/makefun-github-core-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/laoyalaoliu/makefun-github-core-01/reward.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in dependency-free TypeScript (Node 22 standard library only). One process serves git smart HTTP (upload-pack protocol v2, receive-pack v0) for clone, fetch and push; the REST v3 API under /api/v3 for repositories, branches, contents, issues, labels and pull requests (including squash merges); the GraphQL v4 API at /api/graphql with introspection; and a Model Context Protocol endpoint at /mcp (Streamable HTTP, JSON-RPC 2.0) whose tools act on the same store as REST. Git objects, packs and the pkt-line wire are implemented from scratch on node:crypto and node:zlib — no git binary, no packages, no outside service.

## Run it

```sh
node --experimental-strip-types main.ts
```

The process expects MAKEFUN_ENV_URL to name the contest environment it registers with: it binds an ephemeral port, POSTs {"port": N} to $MAKEFUN_ENV_URL/register, serves until GET $MAKEFUN_ENV_URL/done answers {"done": true}, then exits 0. Requests to the forge carry Authorization: Bearer $MAKEFUN_SHOP_TOKEN.

---

<sub>Entered on [make.fun](https://make.fun/?ref=8j9v25ys&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
