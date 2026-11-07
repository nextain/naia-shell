"""Mac App Store review submission through the App Store Connect API.

  check      read build, version and review state only (always safe)
  gate       decide from the commit subject and .github/mas-approvals.json whether
             submitting is allowed; writes allowed=true|false to GITHUB_OUTPUT
  reserve    re-run the gate and push the tag mas-used/<code>; the push fails if the tag
             exists, so a code can be reserved once across all branches, commits and re-runs
  submit     only after a successful reserve: attach the build, append the review note, submit
  mark-used  also note the code as used in .github/mas-approvals.json (best effort)

Only the first line of the commit message is read, so a tag or code quoted in the
body never submits. Never prints the key.
"""
import datetime
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

API = "https://api.appstoreconnect.apple.com"
APPROVALS = ".github/mas-approvals.json"
USED_TAG_PREFIX = "mas-used/"
VERSION = os.environ.get("APP_VERSION", "")
BUILD = os.environ.get("BUILD_NUMBER", "")
NOTE = os.environ.get("REVIEW_NOTE", "").strip()
SUBJECT = (os.environ.get("COMMIT_MESSAGE") or "").splitlines()[0] if os.environ.get("COMMIT_MESSAGE") else ""


def gate():
    """Return (allowed, approval code, reason). Anything unexpected is a refusal."""
    if "[mas-submit]" not in SUBJECT:
        return False, None, "commit subject has no [mas-submit]; read-only check"
    codes = re.findall(r"\bMAS-[0-9A-F]{6}\b", SUBJECT)
    if len(codes) != 1:
        return False, None, "commit subject must carry exactly one approval code MAS-XXXXXX"
    code = codes[0]
    try:
        with open(APPROVALS) as f:
            approvals = json.load(f)
    except (OSError, ValueError) as e:
        return False, code, f"cannot read {APPROVALS}: {e}"
    entry = next((a for a in approvals if a.get("code") == code), None)
    if entry is None:
        return False, code, f"{code} is not in {APPROVALS}"
    if entry.get("used"):
        return False, code, f"{code} was already used ({entry['used']})"
    # The repo-wide tag is the authoritative record; a stale list in an old commit cannot hide it.
    try:
        tags = subprocess.run(["git", "ls-remote", "--tags", "origin", f"refs/tags/{USED_TAG_PREFIX}{code}"],
                              capture_output=True, text=True, timeout=60, check=True).stdout
    except (OSError, subprocess.SubprocessError) as e:
        return False, code, f"cannot check the used tag for {code}: {e}"
    if tags.strip():
        return False, code, f"{code} was already used (tag {USED_TAG_PREFIX}{code} exists)"
    if entry.get("version") != VERSION or str(entry.get("build")) != BUILD:
        return False, code, f"{code} approves {entry.get('version')} ({entry.get('build')}), not {VERSION} ({BUILD})"
    return True, code, f"{code} approves {VERSION} ({BUILD})"


def token():
    import jwt

    now = int(time.time())
    return jwt.encode(
        {"iss": os.environ["ISSUER"], "iat": now, "exp": now + 900, "aud": "appstoreconnect-v1"},
        os.environ["KEY_P8"],
        algorithm="ES256",
        headers={"kid": os.environ["KEY_ID"], "typ": "JWT"},
    )


def call(method, path, body=None):
    req = urllib.request.Request(
        API + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        print(f"{method} {path} -> {e.code}\n{e.read().decode()[:2000]}")
        sys.exit(1)


def read_state():
    app = call("GET", f"/v1/apps?filter[bundleId]={os.environ['BUNDLE_ID']}")["data"][0]
    app_id = app["id"]
    print(f"app {app_id} {app['attributes']['name']}")
    builds = call(
        "GET",
        f"/v1/builds?filter[app]={app_id}&filter[version]={BUILD}"
        f"&filter[preReleaseVersion.version]={VERSION}&filter[preReleaseVersion.platform]=MAC_OS",
    )["data"]
    build = builds[0] if builds else None
    if build:
        ba = build["attributes"]
        print(f"build {build['id']} {VERSION} ({BUILD}) processingState={ba.get('processingState')} "
              f"usesNonExemptEncryption={ba.get('usesNonExemptEncryption')} expired={ba.get('expired')}")
    else:
        print(f"build {VERSION} ({BUILD}) not found")
    versions = call(
        "GET", f"/v1/apps/{app_id}/appStoreVersions?filter[platform]=MAC_OS&filter[versionString]={VERSION}"
    )["data"]
    ver = versions[0] if versions else None
    current = detail = None
    if ver:
        print(f"version {ver['id']} {VERSION} appStoreState={ver['attributes'].get('appStoreState')}")
        current = call("GET", f"/v1/appStoreVersions/{ver['id']}/relationships/build").get("data")
        print(f"version build now: {current and current['id']}")
        detail = call("GET", f"/v1/appStoreVersions/{ver['id']}/appStoreReviewDetail").get("data")
        notes = (detail or {}).get("attributes", {}).get("notes") or ""
        print(f"review detail {detail and detail['id']} notes={len(notes)} chars")
    else:
        print(f"appStoreVersion {VERSION} not found")
    subs = call("GET", f"/v1/reviewSubmissions?filter[app]={app_id}&filter[platform]=MAC_OS&limit=10")["data"]
    for s in subs:
        print(f"reviewSubmission {s['id']} state={s['attributes'].get('state')} "
              f"submittedDate={s['attributes'].get('submittedDate')}")
        if s["attributes"].get("state") in ("READY_FOR_REVIEW", "UNRESOLVED_ISSUES"):
            for i in call("GET", f"/v1/reviewSubmissions/{s['id']}/items")["data"]:
                print(f"  item {i['id']} {json.dumps(i['attributes'])}")
    return app_id, build, ver, current, detail, subs


def submit():
    if os.environ.get("RESERVED") != "true":
        print("approval code was not reserved; not submitting")
        sys.exit(1)
    code = os.environ.get("RESERVED_CODE", "")
    app_id, build, ver, current, detail, subs = read_state()
    if not build or build["attributes"].get("processingState") != "VALID":
        print("build is not processed yet")
        sys.exit(1)
    if not ver:
        sys.exit(1)
    vid = ver["id"]
    if any(s["attributes"].get("state") in ("WAITING_FOR_REVIEW", "IN_REVIEW") for s in subs):
        print("a submission is already waiting or in review; not submitting")
        sys.exit(1)
    open_sub = next((s for s in subs if s["attributes"].get("state") in ("READY_FOR_REVIEW", "UNRESOLVED_ISSUES")), None)

    if not current or current["id"] != build["id"]:
        call("PATCH", f"/v1/appStoreVersions/{vid}/relationships/build", {"data": {"type": "builds", "id": build["id"]}})
        print(f"attached build {build['id']}")
    notes = (detail or {}).get("attributes", {}).get("notes") or ""
    if NOTE and NOTE not in notes:
        merged = f"{notes}\n\n{NOTE}".strip()
        if detail:
            call("PATCH", f"/v1/appStoreReviewDetails/{detail['id']}",
                 {"data": {"type": "appStoreReviewDetails", "id": detail["id"], "attributes": {"notes": merged}}})
        else:
            call("POST", "/v1/appStoreReviewDetails",
                 {"data": {"type": "appStoreReviewDetails", "attributes": {"notes": merged},
                           "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions", "id": vid}}}}})
        print("review note appended")
    if open_sub is None:
        open_sub = call("POST", "/v1/reviewSubmissions",
                        {"data": {"type": "reviewSubmissions", "attributes": {"platform": "MAC_OS"},
                                  "relationships": {"app": {"data": {"type": "apps", "id": app_id}}}}})["data"]
        print(f"created reviewSubmission {open_sub['id']}")
    items = call("GET", f"/v1/reviewSubmissions/{open_sub['id']}/items?include=appStoreVersion")["data"]
    if not any((i.get("relationships", {}).get("appStoreVersion", {}).get("data") or {}).get("id") == vid for i in items):
        call("POST", "/v1/reviewSubmissionItems",
             {"data": {"type": "reviewSubmissionItems",
                       "relationships": {"reviewSubmission": {"data": {"type": "reviewSubmissions", "id": open_sub["id"]}},
                                         "appStoreVersion": {"data": {"type": "appStoreVersions", "id": vid}}}}})
        print("added version to submission")
    # A rejected submission keeps its items as REJECTED until they are marked resolved.
    for i in call("GET", f"/v1/reviewSubmissions/{open_sub['id']}/items")["data"]:
        if i["attributes"].get("state") == "REJECTED":
            call("PATCH", f"/v1/reviewSubmissionItems/{i['id']}",
                 {"data": {"type": "reviewSubmissionItems", "id": i["id"], "attributes": {"resolved": True}}})
            print(f"marked item {i['id']} resolved")
    done = call("PATCH", f"/v1/reviewSubmissions/{open_sub['id']}",
                {"data": {"type": "reviewSubmissions", "id": open_sub["id"], "attributes": {"submitted": True}}})
    print(f"submitted reviewSubmission {open_sub['id']} with {code} "
          f"state={done['data']['attributes'].get('state')}")


def reserve():
    """Claim the code by pushing a tag that cannot be overwritten. Submit runs only if this succeeds."""
    allowed, code, reason = gate()
    print(f"gate: {reason}")
    if not allowed:
        sys.exit(1)
    tag = f"{USED_TAG_PREFIX}{code}"
    # An annotated tag naming this run is a new object, so a second run cannot push the same tag as a no-op.
    subprocess.run(["git", "-c", "user.name=github-actions[bot]",
                    "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
                    "tag", "-a", tag, "-m", f"{code} reserved by run {os.environ.get('GITHUB_RUN_ID', '?')}"],
                   check=True)
    pushed = subprocess.run(["git", "push", "origin", f"refs/tags/{tag}"])
    if pushed.returncode != 0:
        print(f"could not push {tag}; not submitting")
        sys.exit(1)
    print(f"reserved {code} with tag {tag}")
    with open(os.environ["GITHUB_OUTPUT"], "a") as f:
        f.write(f"reserved=true\ncode={code}\n")


def mark_used():
    _, code, _ = gate()
    with open(APPROVALS) as f:
        approvals = json.load(f)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    for a in approvals:
        if a.get("code") == code:
            a["used"] = f"{stamp} run {os.environ.get('GITHUB_RUN_ID', '?')}"
    with open(APPROVALS, "w") as f:
        json.dump(approvals, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"{code} marked used")


cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
print(f"subject: {SUBJECT}")
if cmd == "check":
    read_state()
elif cmd == "gate":
    allowed, _, reason = gate()
    print(f"gate: {'allowed' if allowed else 'refused'}: {reason}")
    with open(os.environ["GITHUB_OUTPUT"], "a") as f:
        f.write(f"allowed={'true' if allowed else 'false'}\n")
elif cmd == "reserve":
    reserve()
elif cmd == "submit":
    submit()
elif cmd == "mark-used":
    mark_used()
else:
    sys.exit(f"unknown command {cmd}")
