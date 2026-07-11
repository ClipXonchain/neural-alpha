"""Post-deploy hook: call register_identity and optionally PATCH platform DB via env."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


def main() -> int:
    agent_id = os.environ.get("AGENT_ID")
    endpoint = os.environ.get("PUBLIC_META_URL")
    trading_wallet = os.environ.get("AGENT_WALLET_ADDRESS")
    data_dir = os.environ.get("AGENT_DATA_DIR", "./data/agents")

    if not agent_id or not endpoint:
        print(json.dumps({"ok": False, "error": "AGENT_ID and PUBLIC_META_URL required"}))
        return 1

    script = Path(__file__).with_name("register_identity.py")
    cmd = [
        sys.executable,
        str(script),
        "--agent-id",
        agent_id,
        "--endpoint",
        endpoint,
        "--data-dir",
        data_dir,
    ]
    if trading_wallet:
        cmd.extend(["--trading-wallet", trading_wallet])

    proc = subprocess.run(cmd, capture_output=True, text=True)
    print(proc.stdout or proc.stderr)
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
