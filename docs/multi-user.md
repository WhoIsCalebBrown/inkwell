# Invited accounts and approval

Fresh installations open a browser setup wizard. You choose the administrator’s
username and password; there are no default credentials and no email service.
Existing installations keep their saved single-user or account access mode.
Approval is on by default; admins can enable automatic approval for everyone
or selected accounts.

## First boot

1. Open Inkwell privately on your LAN or through your HTTPS proxy.
2. Choose an administrator username, optional display name, and password of at
   least 12 characters. Confirm the password. If using direct private-LAN HTTP,
   explicitly acknowledge that passwords are unencrypted. Public HTTP and
   insecure forwarded connections cannot create the first account.
3. Check the Mylar and ComicVine connections, then finish setup. You can create
   the administrator before provider configuration is complete; it is saved
   across restarts. Komga is optional.
4. In **Users**, choose **Create user**, set a username and password, and select
   permissions and a request limit. Friends can change their password after
   signing in. An optional **Invite user** link lets a friend choose their own
   credentials; share it yourself. Links expire after seven days and require no
   email delivery.
5. Use HTTPS before sharing access outside your private LAN. Configure
   `INKWELL_TRUSTED_PROXIES` only for the actual HTTPS proxy. The saved private
   HTTP acknowledgement permits direct private-LAN connections only.

The first eligible visitor chooses the owner account. Once an account exists,
the owner wizard cannot be reopened, including if that account is disabled.
Complete initial setup before publishing the address for others to visit.

## Upgrading an existing installation

Back up `/config`, which contains accounts and approval history. The default
`INKWELL_ACCESS_MODE=auto` preserves a completed legacy installation’s shared
mode. Set it to `multi` and restart to enable accounts; if no account exists,
the browser opens the same administrator wizard. No terminal command is needed.
Explicit `single` retains shared trusted-LAN access. The optional
`create-admin.mjs` utility remains available for terminal-based provisioning.

The optional shared HTTP Basic credentials remain an outer gate. Everyone who
passes that gate still needs their own Inkwell account and role.

## What approval means

- A friend with **Request books** permission may request selected issues or
  collection volumes, future releases, or both together. Submission writes a proposal to Inkwell; a person with
  **Manage requests** permission approves or declines it in **Requests**.
  Only approval sends it to Mylar. Admin requests, accounts with **Auto-approve
  own requests**, or the global automatic approval setting skip that review
  when Mylar's safety checks pass. If those checks fail, the proposal stays
  pending for review.
- The optional limit is **off by default**. In **Settings → Requests**, the
  admin can set a number of items in a rolling number of days. Each selected
  issue or collection volume counts as one item; a future-release follow counts as
  one plus every selected item included with it. Declined and withdrawn requests do not count. An admin can override the
  limit for an account in **Users → Edit → Request limit**; blank inherits the global limit
  and zero means unlimited. The limit applies at submission, including requests
  later approved automatically. It does not limit ComicVine browsing or Mylar's
  GetComics searches.
- **Follow future releases** is a standing request. It works for a series or a
  collection when Mylar supplies a real release date. Inkwell requires readable
  Mylar `config.ini` with both `autowant_all=False` and `autowant_upcoming=False`
  (`0` also works) before approval. It then checks active follows every five
  minutes, queues only releases dated after the UTC approval day, and records
  each Mylar issue id before handing it off. Mylar’s own global automatic
  download switches stay off, so one follow cannot request every active series.
  Missing or unknown release dates wait for later metadata.
- A friend can ask to stop a follow. An admin stops it. This stops Inkwell’s
  future-release monitor only. It does not pause the shared Mylar series or
  cancel selected parts already approved for it.
- Mylar owns the issue list and searches. Inkwell refreshes active follows from
  Mylar’s read-only `getComic` endpoint; a slow or unavailable Mylar leaves the
  last known state visible. An issue Mylar already marks Wanted, Snatched,
  Downloaded, or Archived is treated as handled.

The admin can still use the existing Mylar controls. A non-admin can be granted
**Manage requests** and/or **Manage users** without access to the global Mylar
queue, Komga shelf, diagnostics, cache controls, or direct Mylar write
endpoints. The ComicVine catalogue and rate-limit cooldown remain shared
across the installation.

## Managing users and requests

**Users → Edit** opens a modal with Permissions, Request limit, and Account
sections. Administrators have every permission; their permissions are fixed.
Delegated user managers can grant only permissions they hold. Invitations also
check the creator’s current permissions and account status when redeemed.

**Settings** has General, Requests, User defaults, Connections, and Your account
sections. Global request policy and new-account defaults are separate from each
person’s settings. Display preferences still belong to the current device.
Requesters see only settings and actions their permissions allow.

**Requests** is one list with status filters, title search, and requester filtering
for request managers. Each request names the requester and provides approval or
decline actions when pending. Declining opens a modal for an optional reason.
The admin-only **Mylar activity** tab keeps the existing queue and part controls
for activity that predates accounts and has no recorded requester.

## Next improvements

Useful next steps are a per-friend upcoming-issue feed from Mylar's `getUpcoming`
API, arrival notifications linked to the requesting account, and an admin view
for large or duplicate selections. ComicVine-to-Mylar story arc import, as exposed
by Vine2Mylar, is a separate issue-selection workflow and needs a verified
Mylar API contract before it joins approvals.

## Mylar settings in Inkwell

Administrators can use **Settings → Connections → Mylar request settings** to
change `autowant_all` and `autowant_upcoming`. **Use Inkwell control** selects the
recommended values (both off); **Save Mylar settings** applies them immediately.
These are installation settings, separate from per-device display preferences.
They affect every application using the same Mylar instance. Existing Wanted
issues continue processing; changing these flags does not cancel them.

Mylar has no partial configuration API. Inkwell reads its configuration form and
in-memory settings on the server, preserves its other fields and provider rows,
and saves through Mylar's own handler. Credentials never reach the browser.
Unsupported forms and authenticated web interfaces are refused; the API key is
not a web login. A version check rejects changes made since opening settings,
and a private configuration backup is retained under `/config/backups` when the
configuration mount is readable. This cannot make Mylar's save transactional:
avoid editing Mylar's own settings at the same time. The Mylar appdata mount
continues to be read-only.

Approved requests retain an **Approved** badge while their processing status
changes. Future follows show their approval cutoff, dispatched releases, and
setup or pause warnings. Inkwell waits for a valid Mylar `releaseDate` (ComicVine
store date), strictly after the approval day in UTC and on or before today.
It does not substitute cover dates or include annuals. Mylar's normal metadata
refresh determines when newly listed releases become visible; Inkwell checks
that metadata every five minutes without crawling ComicVine.

Unconfirmed future handoffs are recorded durably and never blindly repeated.
Request managers can **Check / retry** a release: Inkwell first checks fresh
Mylar status, reconciles issues already Wanted or received, and retries only
an issue still eligible under an active follow. An in-flight handoff cannot be
replaced. Stopping a follow prevents later handoffs and leaves selected issues
and other friends' approved follows intact.
