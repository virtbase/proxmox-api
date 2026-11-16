/**
 * Enforces the repository's doc comment conventions on TypeScript sources.
 *
 * @remarks
 * Run it with `bun scripts/check-doc-comments.ts`. Two rules are checked line
 * by line, without parsing the code:
 *
 * 1. Every doc comment uses the expanded block form, with the opening and
 *    closing markers on lines of their own.
 * 2. Every function, method and class declaration is directly preceded by a
 *    comment block.
 *
 * Generated files are held to the first rule only, since their comments come
 * from the Proxmox schema, and so are test files.
 *
 * Violations are printed to standard error, sorted and followed by their
 * count, and the exit code is set to `1`. Otherwise a confirmation is printed
 * to standard output and the exit code stays `0`.
 */

import { Glob } from "bun";

/**
 * Absolute path of the repository root, with a trailing slash.
 */
const ROOT = new URL("..", import.meta.url).pathname;

/**
 * Glob patterns of the files to check, relative to the repository root.
 */
const SOURCES = [
  "packages/*/src/**/*.ts",
  "docs/.vitepress/*.ts",
  "scripts/*.ts",
];

/**
 * Generated files, which are exempt from the rule that every declaration
 * needs a comment.
 */
const GENERATED = new Set([
  "packages/api/src/model.ts",
  "packages/api/src/schema-info.ts",
]);

/**
 * Matches a doc comment that opens and closes on the same line.
 */
const SINGLE_LINE_BLOCK = /^\s*\/\*\*.*\*\/\s*$/;

/**
 * Matches a line that looks like the start of a declaration needing a doc
 * comment.
 *
 * @remarks
 * Two forms are recognised: a named `function` or `class`, with or without
 * `export`, `default` and `async`; and an indented method signature, with or
 * without modifiers, whose line ends after the parameter list, the return
 * type or the opening brace. Arrow functions, interfaces, type aliases and
 * constants are not covered.
 *
 * The second form also matches the first line of an indented call that is
 * split over several lines, such as `readFileSync(`, and
 * {@link NOT_A_DECLARATION} does not filter that out.
 */
const DECLARATION =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*\w+|class\s+\w+)|^\s+(?:(?:public|private|protected|static|override|readonly|async|get|set)\s+)*#?\w+\s*(?:<[^>]*>)?\([^)]*\)?\s*(?::\s*[^;=]+)?\{?\s*$/;

/**
 * Matches the lines {@link DECLARATION} accepts by mistake.
 *
 * @remarks
 * These are statements that start with a keyword or with a call to `expect`,
 * `test`, `describe` or `super`, lines that start with a closing brace,
 * lines that contain an arrow, and calls that are complete on one line.
 * Constructors are excluded as well and so never need a comment.
 */
const PARAMETER = /^\s+(?:\.\.\.)?(?:\w+\??:\s|\{\s)/;
const NOT_A_DECLARATION =
  /^\s*(?:if|for|while|switch|catch|return|throw|await|else|do|new|typeof|expect|test|describe|super|constructor)\b|^\s*\}|=>|^\s*\w+\(.*\);?\s*$/;

/**
 * Reports whether a declaration is directly preceded by a comment block.
 *
 * @remarks
 * Overload signatures between the comment and the declaration are skipped.
 * Nothing else may sit in between, neither a blank line nor a decorator. Any
 * line that consists of a closing comment marker counts, so a plain block
 * comment passes too.
 *
 * @param lines - The file, split into lines.
 * @param index - Index of the declaration line in `lines`.
 * @returns `true` when the declaration is documented.
 */
function isDocumented(lines: string[], index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const line = lines[cursor]?.trim() ?? "";
    if (line === "*/") return true;
    // An overload signature shares the documentation of the one before it.
    if (line.endsWith(";") && /\w\(.*\).*;$/.test(line)) continue;
    return false;
  }
  return false;
}

/**
 * Collects the convention violations in one file.
 *
 * @remarks
 * A file listed in {@link GENERATED} or with `__tests__` in its path is only
 * checked for single-line doc comments.
 *
 * @param path - Repository-relative path, used in the messages and to decide
 *   which rules apply.
 * @param source - The file's content.
 * @returns One message per violation, each starting with `path:line`, in
 *   file order.
 */
function check(path: string, source: string): string[] {
  const problems: string[] = [];
  const lines = source.split("\n");
  const isTest = path.includes("__tests__");

  lines.forEach((line, index) => {
    const where = `${path}:${index + 1}`;
    if (SINGLE_LINE_BLOCK.test(line)) {
      problems.push(`${where} doc comment must use the multi-line form`);
    }
    if (GENERATED.has(path) || isTest) return;
    if (!DECLARATION.test(line) || NOT_A_DECLARATION.test(line)) return;
    // A line ending in `(` opens either a signature or a call; only a
    // signature continues with a parameter.
    if (
      line.trimEnd().endsWith("(") &&
      !PARAMETER.test(lines[index + 1] ?? "")
    ) {
      return;
    }
    if (!isDocumented(lines, index)) {
      problems.push(`${where} declaration has no doc comment`);
    }
  });
  return problems;
}

const problems: string[] = [];
for (const pattern of SOURCES) {
  for await (const path of new Glob(pattern).scan({ cwd: ROOT })) {
    problems.push(...check(path, await Bun.file(`${ROOT}${path}`).text()));
  }
}

if (problems.length > 0) {
  console.error(problems.sort().join("\n"));
  console.error(`\n${problems.length} doc comment problem(s).`);
  process.exitCode = 1;
} else {
  console.log("Doc comments follow the conventions.");
}
