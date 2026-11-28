#!/usr/bin/env python3
import copy
import json
import sys
from pathlib import Path

API_INBOUND_TAG = "api"


def has_api_rule(rules: list, api_tag: str) -> bool:
  """Check whether routing rules already route the api inbound to the api outbound."""
  for rule in rules:
    if not isinstance(rule, dict):
      continue

    inbound_tags = rule.get("inboundTag")
    if isinstance(inbound_tags, str):
      inbound_tags = [inbound_tags]

    if (
      isinstance(inbound_tags, list)
      and API_INBOUND_TAG in inbound_tags
      and rule.get("outboundTag") == api_tag
    ):
      return True

  return False


def main() -> None:
  """Enable Xray Stats API and its api inbound->outbound routing rule in server.json."""
  if len(sys.argv) < 2:
    print("Usage: setup_xray_stats.py <server_json_path>", file=sys.stderr)
    raise SystemExit(1)

  path = Path(sys.argv[1])

  try:
    raw = path.read_text() if path.is_file() else "{}"
  except Exception:
    raw = "{}"

  # Fail closed on malformed JSON so we never overwrite an existing Xray config.
  try:
    data = json.loads(raw.strip() or "{}")
  except Exception:
    print("server.json contains invalid JSON; config left untouched", file=sys.stderr)
    raise SystemExit(2)

  if not isinstance(data, dict):
    data = {}

  original = copy.deepcopy(data)

  data.setdefault("log", {"loglevel": "error"})

  data.setdefault("stats", {})
  api = data.get("api")
  if not isinstance(api, dict):
    api = {}
    data["api"] = api
  api.setdefault("tag", "api")
  services = api.get("services")
  if not isinstance(services, list):
    services = []
  if "StatsService" not in services:
    services.append("StatsService")
  api["services"] = services

  inbounds = data.get("inbounds")
  if not isinstance(inbounds, list):
    inbounds = []
    data["inbounds"] = inbounds

  has_api_inbound = any(
    isinstance(ib, dict)
    and ib.get("protocol") == "dokodemo-door"
    and ib.get("tag") == API_INBOUND_TAG
    for ib in inbounds
  )

  if not has_api_inbound:
    inbounds.append(
      {
        "listen": "127.0.0.1",
        "port": 10085,
        "protocol": "dokodemo-door",
        "settings": {"address": "127.0.0.1"},
        "tag": API_INBOUND_TAG,
      }
    )

  # Without a routing rule for the api inbound, queries to 127.0.0.1:10085 loop
  # back through the default outbound onto 10085 and exhaust open file descriptors.
  routing = data.get("routing")
  if not isinstance(routing, dict):
    routing = {}
    data["routing"] = routing

  rules = routing.get("rules")
  if not isinstance(rules, list):
    rules = []
    routing["rules"] = rules

  if not has_api_rule(rules, api["tag"]):
    rules.insert(
      0,
      {
        "type": "field",
        "inboundTag": [API_INBOUND_TAG],
        "outboundTag": api["tag"],
      },
    )

  policy = data.get("policy")
  if not isinstance(policy, dict):
    policy = {}
    data["policy"] = policy

  levels = policy.get("levels")
  if not isinstance(levels, dict):
    levels = {}
    policy["levels"] = levels

  level0 = levels.get("0")
  if not isinstance(level0, dict):
    level0 = {}
    levels["0"] = level0

  level0["statsUserUplink"] = True
  level0["statsUserDownlink"] = True

  system = policy.get("system")
  if not isinstance(system, dict):
    system = {}
    policy["system"] = system

  system["statsInboundUplink"] = True
  system["statsInboundDownlink"] = True

  # Rewrite only when server.json actually changes so we avoid unnecessary restarts.
  if data == original:
    print("unchanged")
    return

  path.write_text(json.dumps(data, indent=2))
  print("changed")


if __name__ == "__main__":
  main()
