import { toPascalCase } from "./naming.js";
import type { PveCall, PveMethod, PveNode } from "./schema.js";
import { pathVariable } from "./schema.js";

/**
 * The order in which the methods of one path are visited and emitted.
 */
export const METHOD_ORDER: readonly PveMethod[] = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
];

/**
 * One HTTP method on one path, with the identity and name derived for it.
 *
 * @remarks
 * Produced by {@link collectOperations}. The model emitter and the schema
 * diff work on this flat form instead of the tree.
 */
export interface Operation {
  method: PveMethod;
  /**
   * Full path with `{}` placeholders, e.g. `/nodes/{node}/qemu`.
   */
  path: string;
  /**
   * The schema of the call: description, parameters and return value.
   */
  call: PveCall;
  /**
   * Placeholders in the path, outermost first, which the caller supplies
   * through `$()`.
   */
  pathVariables: string[];
  /**
   * Method and path, e.g. `GET /nodes/{node}/qemu`. The identity used in
   * diffs and docs.
   */
  id: string;
  /**
   * Unique PascalCase base for this operation's generated type names: the
   * response interface is named `name`, the parameters `<name>Params`.
   */
  name: string;
}

/**
 * Splits a path into its segments, placeholders included.
 */
function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/**
 * Lists the names an operation may take, most preferred first.
 *
 * @remarks
 * An operation is named after its literal path segments and PVE's handler
 * name. Both inputs are stable upstream, so a name only moves when the
 * endpoint does. The rare clash is settled by spelling out the placeholders,
 * then by appending the method, never by a counter that depends on traversal
 * order.
 *
 * @returns Three candidates: literal segments and handler; all segments and
 *   handler; all segments, handler and method.
 *
 * @example
 * ```ts
 * // `GET /nodes/{node}/qemu/{vmid}/config`, handler `vm_config`
 * nameCandidates(operation);
 * // [
 * //   "NodesQemuConfigVmConfig",
 * //   "NodesNodeQemuVmidConfigVmConfig",
 * //   "NodesNodeQemuVmidConfigVmConfigGET",
 * // ]
 * ```
 */
function nameCandidates(operation: Omit<Operation, "name">): string[] {
  const all = segments(operation.path);
  const literal = all.filter((segment) => !pathVariable(segment));
  const handler = operation.call.name;
  const withVariables = all.map((segment) => pathVariable(segment) ?? segment);
  return [
    toPascalCase([...literal, handler].join(" ")),
    toPascalCase([...withVariables, handler].join(" ")),
    toPascalCase([...withVariables, handler, operation.method].join(" ")),
  ];
}

/**
 * Flattens the API tree into its operations and gives each a unique name.
 *
 * @remarks
 * Names are settled in up to three rounds, one per candidate of
 * {@link nameCandidates}. In each round an operation takes its candidate when
 * no other operation still without a name wants the same one and no earlier
 * round has handed it out. The others move on to the next round. Only the
 * operation's own `name` is checked for uniqueness, not `<name>Params`.
 *
 * @param nodes - The root nodes of the API tree.
 * @returns One operation per method of every path, in tree order: a node's
 *   own methods in {@link METHOD_ORDER}, then its children, depth first.
 * @throws An {@link Error} if operations are left without a unique name
 *   after the third round. The message lists their ids.
 */
export function collectOperations(nodes: PveNode[]): Operation[] {
  const pending: Array<Omit<Operation, "name">> = [];

  /**
   * Queues the operations of one node, then descends into its children.
   *
   * @param variables - Placeholders of the segments above the node,
   *   outermost first.
   */
  const visit = (node: PveNode, variables: string[]): void => {
    const variable = pathVariable(node.text);
    const scope = variable ? [...variables, variable] : variables;
    for (const method of METHOD_ORDER) {
      const call = node.info?.[method];
      if (call) {
        pending.push({
          method,
          path: node.path,
          call,
          pathVariables: scope,
          id: `${method} ${node.path}`,
        });
      }
    }
    for (const child of node.children ?? []) visit(child, scope);
  };
  for (const node of nodes) visit(node, []);

  const candidates = pending.map(nameCandidates);
  const names = new Array<string>(pending.length);
  let unresolved = pending.map((_, index) => index);

  for (let level = 0; level < 3 && unresolved.length > 0; level++) {
    const counts = new Map<string, number>();
    for (const index of unresolved) {
      const name = (candidates[index] as string[])[level] as string;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const taken = new Set(names.filter(Boolean));
    const next: number[] = [];
    for (const index of unresolved) {
      const name = (candidates[index] as string[])[level] as string;
      if (counts.get(name) === 1 && !taken.has(name)) names[index] = name;
      else next.push(index);
    }
    unresolved = next;
  }
  if (unresolved.length > 0) {
    const clashing = unresolved.map((index) => pending[index]?.id).join(", ");
    throw new Error(`could not derive unique type names for: ${clashing}`);
  }

  return pending.map((operation, index) => ({
    ...operation,
    name: names[index] as string,
  }));
}
