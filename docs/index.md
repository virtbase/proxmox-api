---
layout: home
hero:
  name: "@virtbase/proxmox-api"
  text: "Typed Proxmox VE API"
  tagline: Every endpoint of the Proxmox VE 9 API, typed, with the docs in your editor. No runtime dependencies.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Browse endpoints
      link: /reference/endpoints/
features:
  - title: The whole API, typed
    details: "678 operations generated from the schema Proxmox publishes. Parameters, enumerations, return shapes and every description, checked at compile time."
  - title: Paths become property access
    details: "GET /nodes/{node}/qemu/{vmid}/config is proxmox.nodes.$(node).qemu.$(vmid).config.$get(). Nothing to look up."
  - title: No dependencies
    details: "Built on the platform fetch, with no node: imports. Runs on Node, Bun, Deno, workers and the browser."
---
