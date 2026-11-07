"""Submit an uploaded Mac App Store build for review through the App Store Connect API.

A [mas-check] commit subject only reads state. [mas-submit] attaches the build, appends the review
note and submits. Never prints the key.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

import jwt

API = "https://api.appstoreconnect.apple.com"
BUNDLE_ID = os.environ["BUNDLE_ID"]
VERSION = os.environ["APP_VERSION"]
BUILD = os.environ["BUILD_NUMBER"]
# Only the commit subject decides the mode, so a tag quoted in the body never submits.
SUBJECT = os.environ.get("COMMIT_MESSAGE", "").splitlines()[0] if os.environ.get("COMMIT_MESSAGE") else ""
MODE = "submit" if "[mas-submit]" in SUBJECT else "check" if "[mas-check]" in SUBJECT else ""
if not MODE:
    print("no [mas-check] or [mas-submit] in the commit subject; nothing to do")
    sys.exit(0)
print(f"mode {MODE}")
NOTE = os.environ.get("REVIEW_NOTE", "").strip()


def token():
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


app = call("GET", f"/v1/apps?filter[bundleId]={BUNDLE_ID}")["data"][0]
app_id = app["id"]
print(f"app {app_id} {app['attributes']['name']}")

builds = call(
    "GET",
    f"/v1/builds?filter[app]={app_id}&filter[version]={BUILD}"
    f"&filter[preReleaseVersion.version]={VERSION}&filter[preReleaseVersion.platform]=MAC_OS",
)["data"]
if not builds:
    print(f"build {VERSION} ({BUILD}) not found yet")
    sys.exit(1)
build = builds[0]
ba = build["attributes"]
print(f"build {build['id']} {VERSION} ({BUILD}) processingState={ba.get('processingState')} "
      f"usesNonExemptEncryption={ba.get('usesNonExemptEncryption')} expired={ba.get('expired')}")

versions = call(
    "GET", f"/v1/apps/{app_id}/appStoreVersions?filter[platform]=MAC_OS&filter[versionString]={VERSION}"
)["data"]
if not versions:
    print(f"appStoreVersion {VERSION} not found")
    sys.exit(1)
ver = versions[0]
vid = ver["id"]
print(f"version {vid} {VERSION} appStoreState={ver['attributes'].get('appStoreState')}")
current = call("GET", f"/v1/appStoreVersions/{vid}/relationships/build").get("data")
print(f"version build now: {current and current['id']}")

detail = call("GET", f"/v1/appStoreVersions/{vid}/appStoreReviewDetail").get("data")
notes = (detail or {}).get("attributes", {}).get("notes") or ""
print(f"review detail {detail and detail['id']} notes={len(notes)} chars")

subs = call(
    "GET", f"/v1/reviewSubmissions?filter[app]={app_id}&filter[platform]=MAC_OS&include=items&limit=10"
)
open_sub = None
for s in subs["data"]:
    state = s["attributes"].get("state")
    print(f"reviewSubmission {s['id']} state={state} submittedDate={s['attributes'].get('submittedDate')}")
    if state in ("READY_FOR_REVIEW", "UNRESOLVED_ISSUES") and open_sub is None:
        open_sub = s
    if state in ("WAITING_FOR_REVIEW", "IN_REVIEW"):
        print("a submission is already waiting or in review; nothing to do")
        sys.exit(0 if MODE == "check" else 1)

if open_sub is not None:
    for i in call("GET", f"/v1/reviewSubmissions/{open_sub['id']}/items")["data"]:
        print(f"item {i['id']} {json.dumps(i['attributes'])}")

if MODE != "submit":
    print("check only, no changes")
    sys.exit(0)

if ba.get("processingState") != "VALID":
    print("build is not processed yet")
    sys.exit(1)

if not current or current["id"] != build["id"]:
    call("PATCH", f"/v1/appStoreVersions/{vid}/relationships/build", {"data": {"type": "builds", "id": build["id"]}})
    print(f"attached build {build['id']}")

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
has_version = any(
    (i.get("relationships", {}).get("appStoreVersion", {}).get("data") or {}).get("id") == vid for i in items
)
if not has_version:
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
print(f"submitted reviewSubmission {open_sub['id']} state={done['data']['attributes'].get('state')}")
