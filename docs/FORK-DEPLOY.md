# Deploying This Fork

We run our own fork (`github.com/PheonBest/webmux`) instead of the npm-published `webmux`
package, so we can carry features upstream (`windmill-labs/webmux`) hasn't merged yet
(currently: opencode as a third built-in agent, "direct" worktree mode — run an agent on a
branch with no separate `git worktree` — and multi-agent single-workflow sessions).

- Dev clone: `/mnt/d/git/gloweet/webmux`
- Deployed clone: `root@192.168.1.197`, user `ai`, `/git/gloweet/webmux`
- Runs as a systemd **user** service for `ai`: `~/.config/systemd/user/webmux.service`
  (port 5111)

## Why `bun link` instead of npm

`webmux` is already taken on the public npm registry by the upstream project, and we don't
have publishing credentials for it, so a normal `bun install -g webmux` always pulls
upstream's package, not ours. Instead we use `bun link`, which registers the local clone as
the global `webmux` package by name — no registry involved:

```bash
cd /git/gloweet/webmux
bun link
```

This rewrites `~/.bun/install/global/node_modules/webmux` to point at the clone. The
systemd service's `ExecStart=/home/ai/.bun/bin/webmux serve --port 5111` never needs to
change — that path is a bun-managed shim that already resolves through the link.

## First-time setup (already done, for reference)

```bash
ssh root@192.168.1.197
su - ai
export PATH="$HOME/.bun/bin:$PATH"

cd /git/gloweet
git clone https://github.com/PheonBest/webmux.git webmux
cd webmux
bun install
bun run build

bun remove -g webmux   # drop the npm-installed upstream package, if present
bun link               # global "webmux" now resolves to this clone

# register it as a project in the dashboard itself
webmux init
curl -s -X POST localhost:5111/api/projects \
  -H "Content-Type: application/json" \
  -d '{"path":"/git/gloweet/webmux"}'
```

## Redeploying after new changes land on `main`

This is the only part that needs repeating for future updates:

```bash
ssh root@192.168.1.197
su - ai
export PATH="$HOME/.bun/bin:$PATH"

cd /git/gloweet/webmux
git pull origin main
bun install        # only needed if dependencies changed
bun run build

export XDG_RUNTIME_DIR=/run/user/1000
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
systemctl --user restart webmux.service
systemctl --user status webmux.service --no-pager
```

`bun link` only needs to be re-run if the global link was ever removed (e.g. `bun remove
-g webmux` or a fresh `bun install -g webmux` from npm was run by mistake) — otherwise the
global package already points at this clone and pulling + rebuilding in place is enough.

### Notes

- `systemctl --user` over SSH needs `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS` set
  explicitly — a non-interactive `su - ai` shell doesn't have a systemd user session
  bus attached by default.
- Restarting the service does **not** kill existing tmux sessions/panes (tmux is a
  separate daemon) — but webmux's own startup reconciliation will garbage-collect any
  session/window whose underlying worktree directory no longer exists on disk. That's
  expected cleanup, not something the fork-swap itself causes.
- To go back to upstream's npm package: `cd /git/gloweet/webmux && bun uninstall -g` (or
  just `bun remove -g webmux` from any directory) followed by `bun install -g webmux`.
