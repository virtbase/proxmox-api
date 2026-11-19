import { readFileSync } from "node:fs";
import type { HeadConfig, PageData } from "vitepress";
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
 * Origin the site is served from, without a trailing slash. Used for the
 * sitemap, canonical links and social previews, which need absolute URLs.
 */
const siteUrl = "https://proxmox-api.virtbase.com";

/**
 * Name of the site, appended to every page title.
 */
const siteName = "@virtbase/proxmox-api";

/**
 * Default description, used by pages that neither set one in their frontmatter
 * nor match a generated reference page.
 */
const siteDescription = `Typed Proxmox VE ${pveVersion} API client for TypeScript`;

/**
 * Returns the public URL of a page.
 *
 * @remarks
 * The site uses clean URLs, so `.md` is dropped and an `index.md` maps to its
 * directory, matching the URLs in the sitemap.
 *
 * @param relativePath - Path of the page's source file below `docs`, for
 *   example `guide/tasks.md`.
 * @returns The absolute URL, for example `https://…/guide/tasks`.
 */
function pageUrl(relativePath: string): string {
  const path = relativePath
    .replace(/(^|\/)index\.md$/, "$1")
    .replace(/\.md$/, "");
  return `${siteUrl}/${path}`;
}

/**
 * Returns a search-result description for a generated reference page.
 *
 * @remarks
 * Generated pages carry no description of their own, and adding one would
 * mean changing the generator's output for every schema update. Their titles
 * follow a fixed pattern, so the description is derived from the title here.
 *
 * @param relativePath - Path of the page's source file below `docs`.
 * @param title - The page's title.
 * @returns The description, or `undefined` if the page is not a generated
 *   reference page.
 */
function referenceDescription(
  relativePath: string,
  title: string,
): string | undefined {
  if (relativePath === "reference/endpoints/index.md") {
    return `Every operation of the Proxmox VE ${pveVersion} API, grouped by path, with the typed TypeScript call for each.`;
  }
  if (relativePath.startsWith("reference/endpoints/")) {
    return `Proxmox VE API endpoints under ${title}: each operation's path, parameters, return type and typed TypeScript call.`;
  }
  if (relativePath === "reference/api-changelog/index.md") {
    return "Changes to the Proxmox VE API between releases, generated from the published schema, with breaking changes marked.";
  }
  if (relativePath.startsWith("reference/api-changelog/")) {
    return `${title}: endpoints, parameters and return values added, changed or removed, with breaking changes marked.`;
  }
  return undefined;
}

/**
 * Returns the structured data for the home page.
 *
 * @remarks
 * Describes the package as `SoftwareSourceCode`, so search engines can link
 * the site to the repository and the npm package.
 *
 * @returns The JSON-LD document, serialised.
 */
function homeStructuredData(): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareSourceCode",
    name: siteName,
    description: siteDescription,
    url: `${siteUrl}/`,
    codeRepository: "https://github.com/virtbase/proxmox-api",
    programmingLanguage: "TypeScript",
    runtimePlatform: ["Node.js", "Bun", "Deno"],
    license: "https://opensource.org/licenses/MIT",
    author: {
      "@type": "Organization",
      name: "virtbase",
      url: "https://virtbase.com",
    },
  });
}

/**
 * Adds the canonical link, description and social-preview tags of a page.
 *
 * @remarks
 * Runs once per page while the site is built, and mutates the page's
 * data: VitePress renders `description` and the frontmatter's `head` afterwards.
 *
 * @param pageData - The page being built.
 */
function addPageMeta(pageData: PageData): void {
  const { frontmatter, relativePath } = pageData;
  const isHome = relativePath === "index.md";
  const description: string =
    frontmatter.description ??
    referenceDescription(relativePath, pageData.title) ??
    siteDescription;
  pageData.description = description;
  const title = `${pageData.title || siteName} | ${siteName}`;
  const url = pageUrl(relativePath);
  const head: HeadConfig[] = [
    ["link", { rel: "canonical", href: url }],
    ["meta", { property: "og:type", content: isHome ? "website" : "article" }],
    ["meta", { property: "og:url", content: url }],
    ["meta", { property: "og:title", content: title }],
    ["meta", { property: "og:description", content: description }],
  ];
  if (isHome) {
    head.push([
      "script",
      { type: "application/ld+json" },
      homeStructuredData(),
    ]);
  }
  frontmatter.head = [...(frontmatter.head ?? []), ...head];
}

/**
 * VitePress configuration of the documentation site.
 *
 * @remarks
 * The sidebars of the endpoint reference and the API changelog are not listed
 * here; they come from the `sidebar.json` files the generator writes.
 */
export default defineConfig({
  title: siteName,
  description: siteDescription,
  lang: "en-GB",
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: siteUrl },
  transformPageData: addPageMeta,
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/logo.svg" }],
    ["link", { rel: "apple-touch-icon", href: "/apple-touch-icon.png" }],
    ["meta", { name: "theme-color", content: "#e57000" }],
    ["meta", { property: "og:site_name", content: siteName }],
    ["meta", { property: "og:locale", content: "en_GB" }],
    ["meta", { property: "og:image", content: `${siteUrl}/og-image.png` }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    [
      "meta",
      {
        property: "og:image:alt",
        content: "@virtbase/proxmox-api: the Proxmox VE API, fully typed",
      },
    ],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
  ],
  themeConfig: {
    logo: { src: "/logo.svg", alt: "" },
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
