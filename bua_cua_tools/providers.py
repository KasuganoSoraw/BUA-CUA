"""Model provider selection for BUA-CUA CLI commands."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Literal


ProviderName = Literal["qwen", "minimax"]

MINIMAX_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3"
MINIMAX_MODEL = "minimax-m3"
MINIMAX_ENV_PREFIX = "BUA_CUA_MINIMAX"


def load_dotenv_values(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def env_or_dotenv(dotenv: dict[str, str], name: str, default: str = "") -> str:
    return os.environ.get(name) or dotenv.get(name) or default


def selected_provider(args: object) -> ProviderName | None:
    use_qwen = bool(getattr(args, "qwen", False))
    use_minimax = bool(getattr(args, "minimax", False))
    if use_qwen and use_minimax:
        raise ValueError("Use only one provider flag: --qwen or --minimax")
    if use_minimax:
        return "minimax"
    if use_qwen:
        return "qwen"
    return None


def apply_provider_environment(provider: ProviderName | None, dotenv_path: Path | None = None) -> None:
    if provider is None:
        return
    os.environ["BUA_CUA_ACTIVE_PROVIDER"] = provider
    if provider == "qwen":
        return
    if provider != "minimax":
        raise ValueError(f"Unsupported provider: {provider}")

    dotenv = load_dotenv_values(dotenv_path) if dotenv_path else {}
    base_url = env_or_dotenv(dotenv, f"{MINIMAX_ENV_PREFIX}_BASE_URL", MINIMAX_BASE_URL)
    api_key = env_or_dotenv(dotenv, f"{MINIMAX_ENV_PREFIX}_API_KEY")
    model = env_or_dotenv(dotenv, f"{MINIMAX_ENV_PREFIX}_MODEL", MINIMAX_MODEL)

    os.environ["BUA_CUA_GENERATION_BASE_URL"] = base_url
    os.environ["BUA_CUA_GENERATION_MODEL"] = model
    os.environ["BUA_CUA_RECOVERY_BASE_URL"] = base_url
    os.environ["BUA_CUA_RECOVERY_MODEL"] = model
    os.environ["BUA_CUA_ACTIVE_PROVIDER"] = provider
    os.environ["MIDSCENE_MODEL_BASE_URL"] = base_url
    os.environ["MIDSCENE_MODEL_NAME"] = model
    os.environ["OPENAI_BASE_URL"] = base_url

    if api_key:
        os.environ["BUA_CUA_GENERATION_API_KEY"] = api_key
        os.environ["BUA_CUA_RECOVERY_API_KEY"] = api_key
        os.environ["MIDSCENE_MODEL_API_KEY"] = api_key
        os.environ["OPENAI_API_KEY"] = api_key
