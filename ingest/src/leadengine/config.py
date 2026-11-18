"""Settings from the environment (or the repository's .env), plus the hard caps in config/caps.json."""
import json
import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]          # the ai-lead-engine repository
SCHEMA_PATH = ROOT / "schema" / "collections.json"
CAPS_PATH = ROOT / "config" / "caps.json"
DEFAULT_UA = "SolutionAI-LeadEngine/1.0 (+https://solutionai.in)"


def _dotenv(path: Path = ROOT / ".env") -> dict:
    out = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                out[k.strip()] = v.strip().strip("'\"")
    return out


@dataclass(frozen=True)
class Settings:
    mongo_uri: str
    db_name: str
    raw_store: str
    user_agent: str
    caps: dict
    insecure_hosts: frozenset
    # The merged environment (.env, overridden by the process environment). Secrets such as
    # INFYNER_API_KEY, HOLDOUT_SALT and RULES_ENGINE_KEY are read from here, so a key kept in .env
    # works under cron as well as in a shell. Never printed.
    env: dict = field(default_factory=dict, repr=False, compare=False)

    @property
    def crawl(self) -> dict:
        return self.caps.get("crawl", {})


def load_settings(env: dict | None = None) -> Settings:
    env = {**_dotenv(), **os.environ} if env is None else dict(env)
    raw = env.get("RAW_STORE", str(ROOT / "data" / "raw"))
    if not raw.startswith("s3://") and not Path(raw).is_absolute():
        raw = str((ROOT / raw).resolve())
    return Settings(
        mongo_uri=env.get("MONGODB_URI", "mongodb://127.0.0.1:27017"),
        db_name=env.get("LEAD_DB", "solutionai_leads"),
        raw_store=raw,
        user_agent=env.get("CRAWLER_USER_AGENT", DEFAULT_UA),
        caps=json.loads(CAPS_PATH.read_text(encoding="utf-8")),
        insecure_hosts=frozenset(h.strip() for h in env.get("INSECURE_HOSTS", "").split(",") if h.strip()),
        env=env,
    )
