#!/usr/bin/env python3
"""Durable D1 query helper for mehyar_leads_prod.

Usage: python3 d1.py "SELECT ..." ["SELECT ..." ...]
Auth: X-Auth-Email + X-Auth-Key (global key via custom.cloudflare surrogate).
Prints compact JSON per statement. Never prints credential values.
"""
import json, sys, urllib.request, urllib.error

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
import dynamic_credentials as dc

BASE = "https://api.cloudflare.com/client/v4"
CRED = "custom.cloudflare"
ACCOUNT_ID = "621600637337cc1c9ecb7095508bc732"
DB_ID = "f10eb2cb-023a-44d1-bf43-506f0948b9d8"  # mehyar_leads_prod
EMAIL = json.load(open("/home/hatch/workspace/skills/cloudflare/config.json")).get("email")
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"}


def d1(sql):
    req = urllib.request.Request(
        f"{BASE}/accounts/{ACCOUNT_ID}/d1/database/{DB_ID}/query",
        data=json.dumps({"sql": sql}).encode(), method="POST",
        headers={"Content-Type": "application/json", "X-Auth-Email": EMAIL, **UA})
    dc.add_surrogate_to_request(req, CRED, allowed_hosts=["api.cloudflare.com"])
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            d = dc.read_json_response(r)
            res = d.get("result", [{}])[0]
            rows = res.get("results", [])
            print(json.dumps({"rows": rows, "rows_written": res.get("meta", {}).get("rows_written")})[:6000])
    except urllib.error.HTTPError as e:
        print(json.dumps({"sql": sql[:80], "http_error": e.code,
                          "body": e.read(800).decode("utf-8", "replace")[:400]}))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit('usage: d1.py "SQL" ["SQL" ...]')
    for sql in sys.argv[1:]:
        d1(sql)
