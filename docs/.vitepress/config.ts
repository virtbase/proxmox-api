import { readFileSync } from "node:fs";
import { defineConfig } from "vitepress";

/**
 * One link of a generated sidebar, as stored in a `sidebar.json`.
 */
type SidebarItem = { text: string; link: string };

/**
 * Loads the sidebar the generator wrote next to the pages it produced.
 *
 * @remarks
 * The file is read synchronously while the configuration is evaluated, so a
 * missing sidebar stops the site from building.
 *
 * @param directory - Name of the directory below `docs/reference` that holds
 *   the `sidebar.json`.
 * @returns The sidebar items, in the order they are stored.
 * @throws An {@link Error} if the file cannot be read.
 * @throws A {@link SyntaxError} if the file is not valid JSON.
 */
function generatedSidebar(directory: string): SidebarItem[] {
  return JSON.parse(
    readFileSync(
      new URL(`../reference/${directory}/sidebar.json`, import.meta.url),
      "utf8",
    ),
  ) as SidebarItem[];
}

/**
 * The `pve-docs` version pinned in the generator's lock file, for example
 * `9.2.14`.
 */
const { version: pveSchemaVersion } = JSON.parse(
  readFileSync(
    new URL("../../packages/generator/schema.lock.json", import.meta.url),
    "utf8",
  ),
) as { version: string };

/**
 * The Proxmox VE release the site documents, for example `9.2`: the first two
 * components of the pinned version. Shown in the site description and the
 * navigation bar.
 */
const pveVersion = pveSchemaVersion.split(".").slice(0, 2).join(".");

/**
 * VitePress configuration of the documentation site.
 *
 * @remarks
 * The sidebars of the endpoint reference and the API changelog are not listed
 * here; they come from the `sidebar.json` files the generator writes.
 */
export default defineConfig({
  title: "@virtbase/proxmox-api",
  description: `Typed Proxmox VE ${pveVersion} API client for TypeScript`,
  lang: "en-GB",
  cleanUrls: true,
  lastUpdated: true,
  base: "/proxmox-api/",
  head: [["meta", { name: "theme-color", content: "#e57000" }]],
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Client API", link: "/reference/client" },
      { text: "Endpoints", link: "/reference/endpoints/" },
      { text: `PVE ${pveVersion}`, link: "/guide/compatibility" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "Getting started", link: "/guide/getting-started" },
            { text: "Authentication", link: "/guide/authentication" },
            { text: "Calling the API", link: "/guide/calling-the-api" },
            { text: "Tasks", link: "/guide/tasks" },
            { text: "Errors, retries and timeouts", link: "/guide/errors" },
            { text: "Custom fetch", link: "/guide/custom-fetch" },
          ],
        },
        {
          text: "Versions",
          items: [
            { text: "Compatibility", link: "/guide/compatibility" },
            { text: "API changelog", link: "/reference/api-changelog/" },
            { text: "Upgrading", link: "/guide/upgrading" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [{ text: "Client API", link: "/reference/client" }],
        },
        {
          text: "API changelog",
          collapsed: true,
          items: generatedSidebar("api-changelog"),
        },
        { text: "Endpoints", items: generatedSidebar("endpoints") },
      ],
    },
    search: { provider: "local" },
    socialLinks: [
      { icon: "github", link: "https://github.com/virtbase/proxmox-api" },
      {
        icon: "npm",
        link: "https://www.npmjs.com/package/@virtbase/proxmox-api",
      },
    ],
    editLink: {
      pattern: "https://github.com/virtbase/proxmox-api/edit/main/docs/:path",
    },
    footer: {
      message:
        'Released under the MIT License. Based on <a href="https://github.com/UrielCh/proxmox-api">UrielCh/proxmox-api</a>.',
    },
    outline: [2, 3],
  },
});
