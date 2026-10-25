---
name: orgo-machines-6758
description: Inspect Orgo cloud computers and their SSH endpoints through the local Orgo Machines plugin.
---

Use `zcc orgo-machines list` to read the current computer list and `zcc orgo-machines ssh <computer-id>` to inspect an enabled Linux SSH endpoint. These commands never return API credentials.

The Orgo Machines sidebar panel provides power controls with confirmations for disruptive actions. Follow the user’s requested scope; never stop or restart a computer merely to inspect it. Use **Connect to Zana** or **Reconnect to Zana** in the plugin for running Linux computers; SSH setup and pairing are automatic. Settings → Machines remains available for diagnostics. SSH endpoints can change after Orgo moves a computer.

If the account is unconfigured, read the plugin README and use Orgo’s official device authorization flow. Keep credentials in the private local credential file, never in source, chat or command arguments.
