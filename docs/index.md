---
layout: home
hero:
  name: "@virtbase/proxmox-api"
  text: "Typed Proxmox VE API"
  tagline: Every endpoint of the Proxmox VE API, typed from the official schema, with the documentation in your editor. No runtime dependencies.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Browse endpoints
      link: /reference/endpoints/
    - theme: alt
      text: Compatibility
      link: /guide/compatibility
features:
  - title: The whole API, typed
    details: "Generated from the schema Proxmox publishes: parameters, enumerations, return shapes and every description, checked at compile time."
  - title: Paths become property access
    details: "GET /nodes/{node}/qemu/{vmid}/config is proxmox.nodes.$(node).qemu.$(vmid).config.$get(). Nothing to look up."
  - title: Errors you can act on
    details: "Typed errors carry the status, Proxmox's reason and the offending parameters. Tasks that fail in the background are surfaced too."
  - title: Tracks Proxmox automatically
    details: "New Proxmox releases are picked up daily, diffed against the previous schema, and published with an API changelog."
  - title: No dependencies
    details: "Built on the platform fetch. Runs on Node, Bun, Deno and edge runtimes."
---
