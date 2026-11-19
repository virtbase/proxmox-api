---
description: "Authenticate @virtbase/proxmox-api against Proxmox VE with an API token or a username and password, reuse a session ticket, and pick the right realm."
---

# Authentication

Two mechanisms, chosen by which options you pass.

## API tokens

Preferred for anything unattended. Tokens are created per user, can carry a
subset of that user's privileges, can be revoked individually, and do not
expire unless you set an expiry.

```ts
const proxmox = proxmoxApi({
  host: "192.0.2.10",
  tokenID: "root@pam!automation",
  tokenSecret: "12345678-1234-1234-1234-1234567890ab",
});
```

`tokenID` must read `USER@REALM!TOKENNAME`; the constructor throws a
[`ProxmoxConfigError`](./errors#error-classes) straight away if it does not.
The secret is sent as Proxmox issued it and is not validated locally.

The token is sent as an `Authorization` header. No login round trip happens, so
the first call is a single request.

::: warning Not every endpoint accepts a token
Proxmox marks some operations as ticket-only. Those are flagged in the
[endpoint reference](/reference/endpoints/) and in the method's documentation
in your editor; calling one with a token fails with a
[`ProxmoxPermissionError`](./errors#error-classes).
:::

## Username and password

```ts
const proxmox = proxmoxApi({
  host: "192.0.2.10",
  username: "root@pam", // the default when omitted
  password: process.env.PVE_PASSWORD!,
});
```

The client logs in on the first request, then reuses the ticket and its CSRF
token. It looks after the session from there:

- Concurrent requests share a single login.
- Proxmox accepts a ticket for two hours. The client renews it after one, so a
  long-running process never presents a stale one.
- If a ticket is rejected anyway — the cluster's signing key rotated, say — the
  client logs in again, once for all requests in flight, and replays each of
  them once. That is safe for every
  method, because a rejected ticket means the request was never run.

### Two-factor authentication

For an account with TOTP enabled, pass `otp`: a current code, or a function
that returns one.

```ts
import { authenticator } from "otplib";

const proxmox = proxmoxApi({
  host: "192.0.2.10",
  username: "admin@pve",
  password: process.env.PVE_PASSWORD!,
  otp: () => authenticator.generate(process.env.PVE_TOTP_SECRET!),
});
```

The function is called on every login, so it keeps working when the ticket is
renewed; a fixed string only survives the first one. Without `otp`, the login
fails with a `ProxmoxAuthenticationError` whose `tfaRequired` is `true`.

For automation, an API token avoids the second factor altogether.

## Reusing a session

Construct the engine yourself when you want to hold onto the ticket — to hand
it to a noVNC console, for example:

```ts
import proxmoxApi, { ProxmoxEngine } from "@virtbase/proxmox-api";

const engine = new ProxmoxEngine({
  host: "192.0.2.10",
  username: "root@pam",
  password: process.env.PVE_PASSWORD!,
});
const proxmox = proxmoxApi(engine);

const { ticket, CSRFPreventionToken } = await engine.getTicket();
```

`engine.getTicket()` logs in first if there is nothing cached, and
`engine.logout()` forgets the ticket so the next request logs in again.

::: danger
A ticket is a bearer credential. Anything holding it can act as that user until
it expires. Treat it like the password.
:::

## Which realm?

`user@pam` authenticates against the host's Linux users, `user@pve` against
Proxmox's own user database. The realm is part of the username and is not
optional.
