# Security policy

## Reporting a vulnerability

Report privately through
[GitHub's advisory form](https://github.com/virtbase/proxmox-api/security/advisories/new),
or by email to <contact@janic.dev>. Please do not open a public issue for a
vulnerability.

Include what you can: affected version, what an attacker gains, and the steps
to reproduce it. You can expect an acknowledgement within a few days.

## Scope

This is a client library. It holds Proxmox credentials, builds request URLs and
parses replies, so the things worth reporting are along those lines:

- A path segment or parameter that escapes its position in the URL.
- Credentials appearing somewhere they should not — an error message, a log
  line, the `debug` output.
- Certificate verification being weakened by something the library does.
- A parsing path that can be made to hang or exhaust memory on a hostile reply.

Vulnerabilities in Proxmox VE itself belong with
[Proxmox](https://www.proxmox.com/en/about/security), not here.

## Supported versions

The latest published major receives fixes. Older majors do not.
