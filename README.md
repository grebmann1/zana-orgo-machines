# Orgo Machines for Zana

A Zana plugin for your Orgo cloud computers. Click **Connect to Zana** on a running Linux computer to prepare SSH and pair it automatically. **Reconnect to Zana** refreshes its current endpoint and repairs or reuses the existing machine enrollment. Open **Orgo Machines** in Zana’s sidebar to see computers across your Orgo workspaces, filter by name, inspect their current SSH endpoints, and start, stop, restart, suspend or resume them when supported. Stop, restart and suspend require an inline confirmation. The panel refreshes every 15 seconds and tracks asynchronous power operations.

The plugin respects Orgo’s workspace and computer write permissions. It does not create, delete, resize or change billing for computers.

## Install

Requires a current Zana desktop installation on macOS or Linux, an Orgo account with API access, and a running Linux Orgo computer for SSH pairing. Orgo usage and subscription charges are managed by Orgo.

Install the tagged release from the Zana Plugins hub, or use:

```bash
zcc plugin install 'git:https://github.com/grebmann1/zana-orgo-machines.git@ref:v0.2.0'
```

Open **Orgo Machines** in the sidebar after installation. Plugins run as full-trust code in Zana’s server process. This plugin calls Orgo’s HTTPS API, stores a dedicated SSH identity and managed SSH configuration locally, and asks Zana to enroll the selected remote machine. It never receives host-daemon tokens.

## Account connection

The server reads your Orgo API key from `~/.config/zcc-orgo/api-key` on the computer running Zana. Keep the directory private (`0700`) and the file readable only by you (`0600`). An `ORGO_API_KEY` environment variable is also supported when no credential file exists. Never put the key in this project, shell arguments or chat.

Use [Orgo’s official device authorization flow](https://docs.orgo.ai/for-agents), or generate an API key in [Orgo API settings](https://www.orgo.ai/settings/developers), then save it to the private file with a trusted local editor. The panel detects the key on its next refresh. Orgo’s device flow currently grants account-wide access; revoke the key in Orgo to disconnect it. The key stays in the server process and is never returned to the panel or logs.

## Connecting computers

Orgo can change a computer’s SSH host or port after moving it. **Reconnect to Zana** fetches the current endpoint, updates the plugin-managed SSH config and reuses the stored Zana enrollment. Existing manually paired machines are adopted when their SSH alias matches the endpoint, avoiding duplicates.

The plugin preserves existing SSH keys and adds only its dedicated public key. It enables SSH automatically for computers with no saved SSH keys. If Orgo requires a restart, the panel tells you to restart with the power controls and retry. It never restarts or powers on a computer merely to connect it. If SSH was disabled while other saved keys exist, enable it in Orgo first so those keys are preserved. Windows and macOS computers do not support this Linux SSH pairing flow.

Connection jobs run one at a time, show progress and stop when the plugin unloads. Pairing uses the existing main-authorized Zana endpoint; no host-daemon credentials are exposed to the plugin or renderer. Local connections default to `http://127.0.0.1:8780`; `ZCC_SERVER_URL` can select another loopback HTTP port for a development instance. Remote URLs and redirects are rejected.

The managed SSH file is `~/.ssh/zana-orgo-hosts.conf`, included at the top of `~/.ssh/config`. The plugin atomically updates only its own blocks and reuses `~/.ssh/id_ed25519_orgo_zana` (or generates it once if absent). Computer-to-Zana mappings live in the plugin’s private KV storage. The plugin does not continuously enroll machines in the background; each **Connect** starts the automatic setup for that computer.

## Development and verification

```bash
npm ci --ignore-scripts
npm run typecheck
npm run test:coverage
zcc plugin dev --once
```

The plugin ID is `orgo-machines-6758`. The bundled MIT-licensed SDK is a development dependency; see [THIRD_PARTY.md](THIRD_PARTY.md). Zana supplies React at runtime; the plugin does not ship a separate React runtime.

Read-only agent commands:

```bash
zcc orgo-machines list
zcc orgo-machines ssh <computer-id>
```

See [LIVE_TEST.md](LIVE_TEST.md) for the live verification checklist.
