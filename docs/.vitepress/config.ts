import { readFileSync } from "node:fs";
import { defineConfig } from "vitepress";

/**
 * The endpoint pages and their sidebar are written by
 * `@virtbase/proxmox-api-generator`, so the navigation cannot drift from the
 * API surface: regenerating adds and removes entries on its own.
 */
const endpointSidebar = JSON.parse(
  readFileSync(new URL("../reference/endpoints/sidebar.json", import.meta.url), "utf8"),
) as Array<{ text: string; link: string }>;

export default defineConfig({
  title: "@virtbase/proxmox-api",
  description: "Typed Proxmox VE 9 API client for TypeScript",
  lang: "en-GB",
  cleanUrls: true,
  lastUpdated: true,
  // Set for a project page at https://<org>.github.io/proxmox-api/.
  base: "/proxmox-api/",
  head: [["meta", { name: "theme-color", content: "#e57000" }]],
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Client API", link: "/reference/client" },
      { text: "Endpoints", link: "/reference/endpoints/" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "Getting started", link: "/guide/getting-started" },
            { text: "Authentication", link: "/guide/authentication" },
            { text: "Calling the API", link: "/guide/calling-the-api" },
            { text: "Errors and timeouts", link: "/guide/errors-and-timeouts" },
            { text: "Custom fetch", link: "/guide/custom-fetch" },
            { text: "Upgrading from proxmox-api", link: "/guide/upgrading" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [{ text: "Client API", link: "/reference/client" }],
        },
        { text: "Endpoints", items: endpointSidebar },
      ],
    },
    search: { provider: "local" },
    socialLinks: [
      { icon: "github", link: "https://github.com/virtbase/proxmox-api" },
    ],
    footer: {
      message:
        'GPL-3.0. A fork of <a href="https://github.com/UrielCh/proxmox-api">UrielCh/proxmox-api</a>.',
    },
    outline: [2, 3],
  },
});
