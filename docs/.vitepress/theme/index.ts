import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import { NotFound } from "./not-found.js";
import "virtual:group-icons.css";
import "./style.css";

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, { "not-found": () => h(NotFound) }),
} satisfies Theme;
