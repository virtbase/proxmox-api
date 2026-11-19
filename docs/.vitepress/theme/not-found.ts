import { withBase } from "vitepress";
import type { VNode, VNodeArrayChildren } from "vue";
import { defineComponent, h } from "vue";

/**
 * A page a reader who followed a dead link most likely wants instead.
 */
interface Suggestion {
  text: string;
  link: string;
}

/**
 * The pages the 404 page links to, in display order.
 */
const SUGGESTIONS: Suggestion[] = [
  { text: "Getting started", link: "/guide/getting-started" },
  { text: "Endpoint reference", link: "/reference/endpoints/" },
  { text: "Client API", link: "/reference/client" },
  { text: "Home", link: "/" },
];

/**
 * Creates an element with a class and children.
 *
 * @param tag - The element's tag name.
 * @param className - The element's class; styled in `style.css`.
 * @param children - Text or nested elements.
 * @returns The virtual node.
 */
function element(
  tag: string,
  className: string,
  children: string | VNodeArrayChildren = [],
): VNode {
  return h(tag, { class: className }, children);
}

/**
 * Creates the link to one suggested page.
 *
 * @param suggestion - The page to link.
 * @returns The anchor, with the site's base prepended to the link.
 */
function suggestionLink(suggestion: Suggestion): VNode {
  return h("a", { href: withBase(suggestion.link) }, suggestion.text);
}

/**
 * Returns the paragraph that explains why a page may be missing.
 *
 * @returns The paragraph's text and inline elements.
 */
function explanation(): VNodeArrayChildren {
  return [
    "The page may have moved. Large endpoint groups are split into sub-pages, so an operation from ",
    h("code", "nodes / qemu"),
    " may now live on ",
    h("code", "nodes / qemu / agent"),
    ". Search with ",
    h("kbd", "Ctrl"),
    " ",
    h("kbd", "K"),
    " or start from one of these:",
  ];
}

/**
 * Renders the content of the 404 page.
 *
 * @remarks
 * Endpoint groups get split into sub-pages as the API grows, so a stale
 * link usually means an operation moved; the page says so and links the
 * reference.
 *
 * @returns The page's root element.
 */
function renderNotFound(): VNode {
  return element("div", "not-found", [
    element("p", "not-found-code", "404"),
    element("h1", "not-found-title", "Page not found"),
    element("div", "not-found-divider"),
    element("p", "not-found-text", explanation()),
    element("nav", "not-found-links", SUGGESTIONS.map(suggestionLink)),
  ]);
}

/**
 * The content of the 404 page, replacing the default theme's, which only
 * links home.
 */
export const NotFound = defineComponent({
  name: "NotFound",
  setup: () => renderNotFound,
});
