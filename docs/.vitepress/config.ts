import { readFileSync } from "node:fs";
import type { HeadConfig, PageData } from "vitepress";
import { defineConfig } from "vitepress";
import {
  groupIconMdPlugin,
  groupIconVitePlugin,
} from "vitepress-plugin-group-icons";
import llmstxt from "vitepress-plugin-llms";

/**
 * One entry of a generated sidebar, as stored in a `sidebar.json`. The
 * endpoint sidebar nests entries; the changelog sidebar is a flat list.
 */
type SidebarItem = {
  text: string;
  link?: string;
  collapsed?: boolean;
  items?: SidebarItem[];
};

/**
 * Loads the sidebar the generator wrote next to the pages it produced.
 *
 * @remarks
 * The file is read synchronously while the configuration is evaluated, so a
 * missing sidebar stops the site from building.
 *
 * @param directory - Name of the directory below `docs/reference` that holds
 *   the `sidebar.json`.
 * @returns The sidebar entries, in the order they are stored.
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
 * Version of the published package, for example `5.0.0`. Shown in the
 * navigation bar, so readers can tell which release the site describes.
 */
const { version: packageVersion } = JSON.parse(
  readFileSync(
    new URL("../../packages/api/package.json", import.meta.url),
    "utf8",
  ),
) as { version: string };

/**
 * Returns the Markdown of a page as the local search index should see it.
 *
 * @remarks
 * The endpoint pages hold thousands of parameter rows, which made up most
 * of the search index every visitor downloads, while readers search for
 * paths and operations rather than parameter descriptions. On those pages,
 * table rows and the folded `details` blocks are dropped before indexing;
 * headings, call expressions and summaries stay searchable.
 *
 * @param src - The page's Markdown source.
 * @param relativePath - Path of the page's source file below `docs`.
 * @returns The Markdown to index.
 */
function searchableSource(src: string, relativePath: string): string {
  if (!relativePath.startsWith("reference/endpoints/")) return src;
  return src
    .replace(/^::: details[\s\S]*?^:::$/gm, "")
    .replace(/^\|.*\|$/gm, "");
}

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
 * Creates the plugin that writes `llms.txt`, `llms-full.txt` and a Markdown
 * copy of every page, for AI assistants reading the documentation.
 *
 * @remarks
 * `llms-full.txt` leaves out the endpoint reference and the API changelog:
 * together they are megabytes of tables, more than an assistant's context
 * holds, and both stay reachable as individual Markdown pages through
 * `llms.txt`. The hidden "Are you an LLM?" text the plugin would otherwise
 * add to the home page is turned off, since search engines treat hidden text
 * as a spam signal.
 *
 * @returns The Vite plugin.
 */
function llmsPlugin() {
  return llmstxt({
    domain: siteUrl,
    injectLLMHint: false,
    ignoreFilesPerOutput: {
      llmsFullTxt: ["reference/endpoints/**", "reference/api-changelog/**"],
    },
  });
}

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
  markdown: {
    /**
     * Adds the file-type icons to the tabs of code groups.
     *
     * @param md - The Markdown renderer VitePress builds pages with.
     */
    config(md) {
      // VitePress 1.6 bundles markdown-it typings older than the ones the
      // plugin is typed against; at run time it is the same instance.
      md.use(groupIconMdPlugin as unknown as Parameters<typeof md.use>[0]);
    },
  },
  vite: {
    plugins: [groupIconVitePlugin(), llmsPlugin()],
  },
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
      {
        text: `v${packageVersion}`,
        items: [
          {
            text: "Release notes",
            link: "https://github.com/virtbase/proxmox-api/blob/main/packages/api/CHANGELOG.md",
          },
          { text: "Upgrading", link: "/guide/upgrading" },
          { text: "Compatibility", link: "/guide/compatibility" },
          { text: "API changelog", link: "/reference/api-changelog/" },
        ],
      },
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
      "/reference/endpoints/": generatedSidebar("endpoints"),
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "Client API", link: "/reference/client" },
            { text: "Endpoints", link: "/reference/endpoints/" },
          ],
        },
        {
          text: "API changelog",
          collapsed: true,
          items: generatedSidebar("api-changelog"),
        },
      ],
    },
    externalLinkIcon: true,
    search: {
      provider: "local",
      options: {
        /**
         * Renders a page for the search index, see {@link searchableSource}.
         *
         * @returns The HTML to index, or an empty string for a page that
         *   opts out with `search: false` in its frontmatter.
         */
        _render(src, env, md) {
          const html = md.render(searchableSource(src, env.relativePath), env);
          return env.frontmatter?.search === false ? "" : html;
        },
      },
    },
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
