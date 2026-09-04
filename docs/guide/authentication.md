# Authentication

Two mechanisms, chosen by which options you pass.

## API tokens

Preferred for anything unattended. Tokens are created per user, carry their own
privileges, can be revoked individually, and never expire.

```ts
const proxmox = proxmoxApi({
  host: "192.0.2.10",
  port: 8006,
  tokenID: "root@pam!automation",
  tokenSecret: "12345678-1234-1234-1234-1234567890ab",
});
```

`tokenID` must read `USER@REALM!TOKENID` and `tokenSecret` must be a lowercase
UUID; the constructor throws immediately if either is malformed rather than
failing later on the first request.

The token is sent as an `Authorization` header. No login round trip happens, so
the first call is a single request.

::: warning Not every endpoint accepts a token
Proxmox marks some operations as ticket-only — `POST /access/ticket` among
them. Those are flagged in the [endpoint reference](/reference/endpoints/), and
calling one with a token fails with `401`.
:::

## Username and password

```ts
const proxmox = proxmoxApi({
  host: "192.0.2.10",
  port: 8006,
  username: "root@pam", // the default when omitted
  password: process.env.PVE_PASSWORD!,
});
```

The client logs in on the first request, then reuses the ticket and its
`CSRFPreventionToken` for subsequent calls. Proxmox tickets last two hours; when
one is rejected the client discards it, logs in again and retries the request
once.

## Reusing a session

Construct the engine yourself when you want to hold onto the ticket — to share
it between clients, or to persist it:

```ts
import proxmoxApi, { ProxmoxEngine } from "@virtbase/proxmox-api";

const engine = new ProxmoxEngine({
  host: "192.0.2.10",
  port: 8006,
  username: "root@pam",
  password: process.env.PVE_PASSWORD!,
});

const proxmox = proxmoxApi(engine);

await proxmox.version.$get();
console.log(engine.ticket, engine.CSRFPreventionToken);
```

`engine.getTicket()` returns the current credentials, logging in first if there
is nothing cached.

::: danger
A ticket is a bearer credential. Anything holding it can act as that user until
it expires. Treat it like the password.
:::

## Which realm?

`user@pam` authenticates against the host's Linux users, `user@pve` against
Proxmox's own user database. The realm is part of the username and is not
optional.
