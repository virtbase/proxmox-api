import type { PveNode, PveSchema } from "../schema.js";

/**
 * Schema of the `node` path parameter, shared by the fixture's operations.
 */
const node: PveSchema = { type: "string", format: "pve-node" };

/**
 * Schema of the `vmid` path parameter, shared by the fixture's operations.
 */
const vmid: PveSchema = { type: "integer", minimum: 100 };

/**
 * Builds a miniature API tree with the schema shapes the generator's tests
 * rely on.
 *
 * @remarks
 * Its four operations, from `/nodes` down to `/nodes/{node}/qemu/{vmid}`,
 * cover nested path placeholders, a parameter object that accepts unlisted
 * keys, an indexed property (`net[n]`), an enumeration with a single value
 * set (`ostype`) and an ambiguous one (`status`), booleans as a parameter
 * and as a returned property, both permission notations and an operation
 * that API tokens may not call.
 *
 * @returns A new tree on every call, so a test may mutate its copy freely.
 */
export function fixture(): PveNode[] {
  return [
    {
      path: "/nodes",
      text: "nodes",
      leaf: 0,
      info: {
        GET: {
          method: "GET",
          name: "index",
          description: "Cluster node index.",
          permissions: { user: "all" },
          parameters: { additionalProperties: 1, properties: {} },
          returns: {
            type: "array",
            items: {
              type: "object",
              properties: {
                node: { type: "string" },
                status: { enum: ["online", "offline"] },
              },
            },
          },
        },
      },
      children: [
        {
          path: "/nodes/{node}",
          text: "{node}",
          leaf: 0,
          info: {
            GET: {
              method: "GET",
              name: "index",
              parameters: { properties: { node } },
              returns: {
                type: "array",
                items: { type: "object", properties: {} },
              },
            },
          },
          children: [
            {
              path: "/nodes/{node}/qemu",
              text: "qemu",
              leaf: 0,
              info: {
                POST: {
                  method: "POST",
                  name: "create_vm",
                  description: "Create a VM.",
                  permissions: {
                    check: ["perm", "/vms/{vmid}", ["VM.Allocate"]],
                  },
                  parameters: {
                    properties: {
                      node,
                      vmid,
                      "net[n]": {
                        type: "string",
                        optional: 1,
                        description: "Network device.",
                      },
                      ostype: {
                        type: "string",
                        optional: 1,
                        enum: ["l26", "win11"],
                      },
                      status: {
                        type: "string",
                        optional: 1,
                        enum: ["running", "stopped"],
                      },
                      onboot: { type: "boolean", optional: 1 },
                    },
                  },
                  returns: { type: "string" },
                },
              },
              children: [
                {
                  path: "/nodes/{node}/qemu/{vmid}",
                  text: "{vmid}",
                  leaf: 1,
                  info: {
                    GET: {
                      method: "GET",
                      name: "vm_config",
                      allowtoken: 0,
                      parameters: { properties: { node, vmid } },
                      returns: {
                        type: "object",
                        properties: {
                          onboot: { type: "boolean", optional: 1 },
                          ostype: {
                            type: "string",
                            optional: 1,
                            enum: ["l26", "win11"],
                          },
                          "net[n]": {
                            type: "string",
                            optional: 1,
                            description: "Network device.",
                          },
                        },
                      },
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  ];
}
