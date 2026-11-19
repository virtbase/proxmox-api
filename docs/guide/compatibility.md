---
description: "Which @virtbase/proxmox-api release matches which Proxmox VE version, what compatible means, and how to check the cluster version at run time."
---

<script setup>
import { data as releases } from "../.vitepress/compatibility.data.ts";

const minor = (version) => version.split(".").slice(0, 2).join(".");
</script>

# Compatibility

Every release of `@virtbase/proxmox-api` is generated from one exact version of
the Proxmox VE API schema. Install the release whose schema matches the Proxmox
VE version your cluster runs.

## Which release for which Proxmox VE

<table>
  <thead>
    <tr><th>@virtbase/proxmox-api</th><th>Proxmox VE</th><th>Schema (<code>pve-docs</code>)</th></tr>
  </thead>
  <tbody>
    <tr v-for="release in releases" :key="release.version">
      <td><code>{{ release.version }}</code></td>
      <td>{{ minor(release.schema) }}</td>
      <td><a :href="`../reference/api-changelog/pve-${minor(release.schema)}`">{{ release.schema }}</a></td>
    </tr>
  </tbody>
</table>

Before 2.0.0 the package was published as
[`proxmox-api`](https://www.npmjs.com/package/proxmox-api): its 1.x releases
describe Proxmox VE 8, and 0.x releases Proxmox VE 6 and 7.

Proxmox VE 8 reached end of life in August 2026, so only the 9.x line is
tracked now.

## What "compatible" means

The types describe the API of one Proxmox VE version; the client itself works
against any of them. Running a different version than the one a release was
generated from has two effects:

- **Older cluster than the types.** Endpoints and parameters added since do not
  exist on your cluster. They type-check, and fail at run time with a
  [`ProxmoxApiError`](./errors) (`501` for an unknown endpoint, `400` for an
  unknown parameter).
- **Newer cluster than the types.** Everything that type-checks works, apart
  from the rare endpoint Proxmox removed. Anything added since is missing from
  the types until you upgrade the package.

The [API changelog](/reference/api-changelog/) lists exactly what differs
between versions, so you can judge whether a mismatch matters to you.

## Checking at run time

The schema version is exported, so a service can compare it with the cluster it
connects to:

```ts
import proxmoxApi, { PVE_SCHEMA_VERSION, PVE_VERSION } from "@virtbase/proxmox-api";

const { release } = await proxmox.version.$get();
if (release !== PVE_VERSION) {
  console.warn(
    `Cluster runs Proxmox VE ${release}; types describe ${PVE_VERSION} (pve-docs ${PVE_SCHEMA_VERSION}).`,
  );
}
```

| Constant | Example | |
| --- | --- | --- |
| `PVE_VERSION` | `"9.2"` | The Proxmox VE release the types describe. |
| `PVE_SCHEMA_VERSION` | `"9.2.14"` | The exact `pve-docs` package the schema came from. |
| `PVE_OPERATION_COUNT` | `684` | Number of operations covered. |

`GET /version` reports the cluster's `pve-manager` version (`9.2.28`), whose
patch number is unrelated to `pve-docs`. Compare `release` with `PVE_VERSION`,
not the full versions.

## How versions are chosen

The schema comes from the `pve-docs` Debian package in Proxmox's public
repository — the only place Proxmox publishes it with a version attached. A
scheduled job checks for a new one every day, regenerates the types, and
classifies the difference:

| Schema change | Package release |
| --- | --- |
| An endpoint or parameter removed, a parameter newly required, a return value removed or changed type | **major** |
| Endpoints, parameters or return values added | **minor** |
| Descriptions or metadata only | **patch** |
| Schema unchanged | none |

Additive updates are released automatically. Breaking ones wait for a
maintainer to review them first.

Proxmox aims to stay API compatible within a major version, but does remove
deprecated parameters in minor releases now and then — 9.2 dropped `maxfiles`
from the backup endpoints, for instance. That is why a Proxmox VE *minor* can
produce a *major* release here: semantic versioning follows what breaks your
build, not Proxmox's numbering.

Pin a major (`^4.0.0`) to receive additive schema updates without surprises.
