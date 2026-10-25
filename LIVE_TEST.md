# Live verification: Orgo Machines

Use the running ZCC instance. Keep `ZCC_SERVER_URL` and `ZCC_DATA_DIR` pointed at the same instance. Do not change session credentials or installed-plugin records.

1. Run `zcc plugin dev --once` here. Check `zcc plugin logs orgo-machines-6758 -n 50` if reload fails.
2. Open **Orgo Machines** in Zana using computer use. Verify the panel fills its host and shows an account setup message when no credential is configured.
3. With account authorization, verify the computer names, statuses and specs against Orgo. Click **Refresh**, filter the list, and inspect **SSH details**. Compare with `zcc orgo-machines list` and `zcc orgo-machines ssh <id>`.
4. Click **Connect to Zana** for a running Linux computer. Verify progress, **Connected to Zana**, and the persisted **Reconnect to Zana** action. Confirm an existing enrollment is reused, with no duplicate machine or project. Reload the plugin and verify the connection mapping survives.
5. Open **Restart** confirmation and **Cancel**. No API power change should run. Unit tests cover accepted power requests and operation polling; do not disrupt a working computer just to test the UI.
6. Make a visible source text edit, rebuild/reload with `zcc plugin dev --once`, and verify the already-open panel updates. Restore the text and reload again.
7. Verify **Settings → Machines** shows the selected computer connected. Open or register a project on that remote machine and verify its remote path.

Record the observed result. A successful reload alone does not prove the UI rendered. Keep private observations and account identifiers out of public commits.
