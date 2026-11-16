import { ProxmoxError } from "./errors.js";
import type { Proxmox } from "./model.js";

/**
 * `info` subcommands that take no argument.
 *
 * `mem` and `tlb` are left out on purpose: both time out through the PVE
 * monitor endpoint.
 */
const VALID_QEMU_INFO_SIMPLE = [
  "backup",
  "balloon",
  "block-jobs",
  "blockstats",
  "capture",
  "chardev",
  "cpus",
  "cpustats",
  "dump",
  "history",
  "hotpluggable-cpus",
  "ioapic",
  "iothreads",
  "irq",
  "jit",
  "kvm",
  "memdev",
  "memory-devices",
  "memory_size_summary",
  "mice",
  "migrate",
  "migrate_cache_size",
  "migrate_capabilities",
  "migrate_parameters",
  "name",
  "network",
  "numa",
  "opcount",
  "pci",
  "pic",
  "profile",
  "qdm",
  "qtree",
  "ramblock",
  "rdma",
  "roms",
  "savevm",
  "sev",
  "snapshots",
  "spice",
  "status",
  "tpm",
  "usb",
  "usbhost",
  "usernet",
  "uuid",
  "version",
  "vm-generation-id",
  "vnc",
] as const;

/**
 * `info` subcommands that accept optional arguments.
 */
const VALID_QEMU_INFO_OPTION = [
  "block",
  "lapic",
  "mtree",
  "qom-tree",
  "registers",
  "sync-profile",
  "trace-events",
] as const;

/**
 * `info` subcommands that need at least one argument.
 */
const VALID_QEMU_INFO_PARAM = [
  "rocker-of-dpa-flows",
  "rocker-of-dpa-groups",
  "rocker-ports",
] as const;

/**
 * Name of an `info` subcommand that {@link QmMonitor.info} sends without
 * arguments.
 */
export type QemuInfoSimple = (typeof VALID_QEMU_INFO_SIMPLE)[number];

/**
 * Name of an `info` subcommand that {@link QmMonitor.info} sends with or
 * without arguments.
 */
export type QemuInfoOption = (typeof VALID_QEMU_INFO_OPTION)[number];

/**
 * Name of an `info` subcommand that {@link QmMonitor.info} only sends with
 * at least one argument.
 */
export type QemuInfoParam = (typeof VALID_QEMU_INFO_PARAM)[number];

/**
 * One USB device attached to the guest, as parsed from `info usb` by
 * {@link QmMonitor.infoUsb}.
 */
export interface USBInfo {
  /**
   * The device's address as QEMU prints it, e.g. `1.1`.
   */
  device: string;
  /**
   * Port of the guest's USB bus the device sits on, e.g. `1`.
   */
  port: string;
  /**
   * Speed with its unit, e.g. `1.5 Mb/s`.
   */
  speed: string;
  /**
   * Product name exactly as QEMU prints it, which can end in a space.
   *
   * Absent for a device QEMU reports without a product string - the trailing
   * `, Product ..., ID: ...` is optional in the monitor's own output, and is
   * only recognised as a whole.
   */
  product?: string;
  /**
   * Identifier the device was added under, which
   * {@link QmMonitor.deviceDel} takes. Absent for the same reason as
   * {@link USBInfo.product}.
   */
  id?: string;
}

/**
 * One USB device present on the host, as parsed from `info usbhost` by
 * {@link QmMonitor.infoUsbhost}.
 */
export interface USBHostInfo {
  /**
   * Number of the host bus the device is on.
   */
  bus: number;
  /**
   * Address of the device on that bus.
   */
  addr: number;
  /**
   * Physical port on that bus, e.g. `2`. Together with `bus` it is what
   * {@link QmMonitor.deviceAddByPort} takes.
   */
  port: string;
  /**
   * Speed with its unit, e.g. `480 Mb/s`.
   */
  speed: string;
  /**
   * Device class code as printed, e.g. `00`.
   */
  class: string;
  /**
   * Four lower-case hexadecimal digits without a `0x` prefix, e.g. `046d`.
   */
  vendorId: string;
  /**
   * Four lower-case hexadecimal digits without a `0x` prefix, e.g. `c52b`.
   */
  productId: string;
  /**
   * Product name as the host reports it. May be empty.
   */
  name: string;
}

/**
 * Narrows which host devices {@link QmMonitor.infoUsbhost} returns.
 *
 * A device is kept when it matches every pattern given; an empty filter
 * keeps all of them. Each pattern is applied with `RegExp.prototype.test`
 * to one device after another, so it must not carry the `g` or `y` flag,
 * which make `test` remember its position between calls.
 */
export interface USBHostFilter {
  /**
   * Tested against {@link USBHostInfo.vendorId}.
   */
  vendorId?: RegExp;
  /**
   * Tested against {@link USBHostInfo.productId}.
   */
  productId?: RegExp;
  /**
   * Tested against {@link USBHostInfo.name}.
   */
  name?: RegExp;
}

/**
 * Matches one device in the reply to `info usb`, capturing device, port,
 * speed and - when present - product and id.
 *
 * ```text
 * Device 1.1, Port 1, Speed 1.5 Mb/s, Product USB OPTICAL MOUSE , ID: mouse
 * Device 1.0, Port 2, Speed 12 Mb/s, Product Gaming KB , ID: keyboard
 * ```
 */
const GUEST_USB =
  /Device ([\d.]+), Port ([\d.]+), Speed ([\d KMGTbfs/.]+)(?:, Product (.+), ID: (.+))?/g;

/**
 * Matches one device in the reply to `info usbhost`, which spans two lines,
 * capturing bus, address, port, speed, class, vendor id, product id and
 * name.
 *
 * ```text
 * Bus 1, Addr 4, Port 2, Speed 480 Mb/s
 *   Class 00: USB device 1234:5678, Some Device
 * ```
 */
const HOST_USB =
  /Bus (\d+), Addr (\d+), Port ([\d.]+), Speed ([\d KMGTbfs/.]+)[\r\n]\s+Class (\d+): USB device ([0-9a-f]{4}):([0-9a-f]{4}), (.*)/gm;

/**
 * Strips an optional `0x` prefix, in either case, from a USB vendor or
 * product id.
 */
function bareHexId(value: string): string {
  return value.replace(/^0x/i, "");
}

/**
 * Gives access to the QEMU monitor of one guest, over
 * `POST /nodes/{node}/qemu/{vmid}/monitor`; use it for monitor commands that
 * have no endpoint of their own.
 *
 * @remarks
 * The monitor is a debugging interface: commands are passed through
 * unvalidated and replies are unstructured text whose format is not stable
 * across QEMU versions. Prefer a real endpoint wherever one exists.
 *
 * Every method sends at least one request and fails with the error of that
 * request - a {@link ProxmoxError} when the client is backed by a
 * {@link ProxmoxEngine}. Nothing here is retried, as the requests are
 * `POST`s.
 */
export class QmMonitor {
  /**
   * Name of the node the guest runs on.
   */
  readonly node: string;
  /**
   * Id of the guest.
   */
  readonly vmid: number;
  /**
   * Sends a raw monitor command and returns its unparsed reply.
   *
   * @param command - The command line, handed to the monitor as it is.
   * @returns The monitor's reply as text.
   * @throws A {@link ProxmoxError} if the request fails.
   */
  readonly monitor: (command: string) => Promise<string>;

  /**
   * Binds a monitor to one guest, without sending anything.
   *
   * @param proxmox - Client to send the monitor commands through.
   * @param node - Name of the node the guest runs on.
   * @param vmid - Id of the guest.
   * @throws A {@link ProxmoxConfigError} if `node` is empty, `.` or `..`.
   */
  constructor(proxmox: Proxmox.Api, node: string, vmid: number) {
    this.node = node;
    this.vmid = vmid;
    const endpoint = proxmox.nodes.$(node).qemu.$(vmid).monitor;
    this.monitor = (command) => endpoint.$post({ command });
  }

  /**
   * Runs `info <type>` for a subcommand that takes no argument.
   *
   * @param type - The `info` subcommand.
   * @returns The monitor's unparsed reply.
   * @throws A {@link ProxmoxError} if the request fails.
   */
  info(type: QemuInfoSimple): Promise<string>;
  /**
   * Runs `info <type>` for a subcommand that accepts arguments.
   *
   * @param type - The `info` subcommand.
   * @param args - Arguments for the subcommand, appended to the command
   *   separated by single spaces and otherwise as given.
   * @returns The monitor's unparsed reply.
   * @throws A {@link ProxmoxError} if the request fails.
   */
  info(type: QemuInfoOption, ...args: string[]): Promise<string>;
  /**
   * Runs `info <type>` for a subcommand that needs at least one argument.
   *
   * @param type - The `info` subcommand.
   * @param arg1 - The argument the subcommand requires.
   * @param args - Further arguments. All of them are appended to the command
   *   separated by single spaces and otherwise as given.
   * @returns The monitor's unparsed reply.
   * @throws A {@link ProxmoxError} if the request fails.
   */
  info(type: QemuInfoParam, arg1: string, ...args: string[]): Promise<string>;
  /**
   * Joins the subcommand and its arguments into one `info` command and
   * sends it; the overloads above say which arguments each subcommand
   * takes.
   */
  async info(
    type: QemuInfoSimple | QemuInfoOption | QemuInfoParam,
    ...args: string[]
  ): Promise<string> {
    const suffix = args.length > 0 ? ` ${args.join(" ")}` : "";
    return this.monitor(`info ${type}${suffix}`);
  }

  /**
   * Lists the USB devices currently attached to the guest, from `info usb`.
   *
   * @returns One entry per device, in the order of the reply. Empty for an
   *   empty reply.
   * @throws A {@link ProxmoxError} with code `response` if the number of
   *   devices recognised differs from the number of lines in the reply, which
   *   means the output format changed and the result would be silently short.
   * @throws A {@link ProxmoxError} if the request fails.
   */
  async infoUsb(): Promise<USBInfo[]> {
    const text = await this.info("usb");
    const expected = (text.match(/[\r\n]+/g) ?? []).length;
    const devices: USBInfo[] = [];

    for (const match of text.matchAll(GUEST_USB)) {
      const [, device = "", port = "", speed = "", product, id] = match;
      devices.push({ device, port, speed, product, id });
    }

    if (devices.length !== expected) {
      throw new ProxmoxError(
        "response",
        `Parsed ${devices.length} USB devices but the reply has ${expected} lines. ` +
          `The monitor output format may have changed:\n${text}`,
      );
    }
    return devices;
  }

  /**
   * Lists the USB devices present on the host, from `info usbhost`,
   * optionally narrowed by vendor id, product id or name.
   *
   * @remarks
   * Unlike {@link QmMonitor.infoUsb}, this does not verify that the whole
   * reply was understood: an entry the pattern does not recognise is left
   * out without an error.
   *
   * @param filter - Keeps only the devices that match every pattern given.
   *   All devices are returned when it is omitted.
   * @returns The devices, in the order of the reply.
   * @throws A {@link ProxmoxError} if the request fails.
   */
  async infoUsbhost(filter?: USBHostFilter): Promise<USBHostInfo[]> {
    const text = await this.info("usbhost");
    const devices: USBHostInfo[] = [];

    for (const match of text.matchAll(HOST_USB)) {
      const [
        ,
        bus = "",
        addr = "",
        port = "",
        speed = "",
        deviceClass = "",
        vendorId = "",
        productId = "",
        name = "",
      ] = match;
      devices.push({
        bus: Number(bus),
        addr: Number(addr),
        port,
        speed,
        class: deviceClass,
        vendorId,
        productId,
        name,
      });
    }

    if (!filter) return devices;
    return devices.filter(
      (usb) =>
        (!filter.name || filter.name.test(usb.name)) &&
        (!filter.vendorId || filter.vendorId.test(usb.vendorId)) &&
        (!filter.productId || filter.productId.test(usb.productId)),
    );
  }

  /**
   * Attaches a host USB device to the guest by vendor and product id.
   *
   * @remarks
   * Sends `device_add usb-host,vendorid=0x...,productid=0x...,id=...`. The
   * values are inserted into the command as given, without validation or
   * escaping.
   *
   * @param id - Identifier for the new device, used to detach it later.
   * @param params - The device to attach.
   * @param params.vendorId - Vendor id in hexadecimal, with or without a
   *   `0x` prefix.
   * @param params.productId - Product id in hexadecimal, with or without a
   *   `0x` prefix.
   * @returns The monitor's unparsed reply.
   * @throws A {@link ProxmoxError} if the request fails.
   */
  async deviceAddById(
    id: string,
    params: { vendorId: string; productId: string },
  ): Promise<string> {
    const vendorId = bareHexId(params.vendorId);
    const productId = bareHexId(params.productId);
    return this.monitor(
      `device_add usb-host,vendorid=0x${vendorId},productid=0x${productId},id=${id}`,
    );
  }

  /**
   * Attaches a host USB device to the guest by physical port, which survives
   * swapping a device for another of the same model.
   *
   * @remarks
   * Sends `device_add usb-host,hostbus=...,hostport=...,id=...`. The values
   * are inserted into the command as given, without validation or escaping.
   *
   * @param id - Identifier for the new device, used to detach it later.
   * @param params - The port to attach; a {@link USBHostInfo} fits.
   * @param params.bus - Number of the host bus.
   * @param params.port - Port on that bus.
   * @returns The monitor's unparsed reply.
   * @throws A {@link ProxmoxError} if the request fails.
   */
  async deviceAddByPort(
    id: string,
    params: { bus: number; port: string },
  ): Promise<string> {
    return this.monitor(
      `device_add usb-host,hostbus=${params.bus},hostport=${params.port},id=${id}`,
    );
  }

  /**
   * Detaches a device previously added under `id`, by sending
   * `device_del <id>`.
   *
   * @param id - Identifier the device was added under. It is inserted into
   *   the command as given.
   * @returns The monitor's unparsed reply.
   * @throws A {@link ProxmoxError} if the request fails.
   */
  async deviceDel(id: string): Promise<string> {
    return this.monitor(`device_del ${id}`);
  }

  /**
   * Attaches every host USB device matching `filter`, by physical port,
   * provided nothing is attached to the guest under `id` yet.
   *
   * @remarks
   * The first is added as `id`, subsequent ones as `id-1`, `id-2` and so on.
   * The check against the guest covers `id` alone: whether a matching host
   * device is already attached under another identifier is not looked at.
   *
   * The devices are attached one at a time, after one `info usb` and one
   * `info usbhost` request. When a request fails, the devices attached
   * before it stay attached.
   *
   * @param id - Identifier for the first device and stem for the others.
   * @param filter - Selects the host devices. An empty filter selects every
   *   USB device on the host.
   * @returns The ids that were attached, in order. Empty when no host device
   *   matches.
   * @throws A {@link ProxmoxError} with code `config` if a device is already
   *   attached to the guest under `id`, with code `response` if the reply to
   *   `info usb` cannot be parsed in full, and with the request's own code if
   *   a request fails.
   */
  async deviceAddMissing(id: string, filter: USBHostFilter): Promise<string[]> {
    const attached = await this.infoUsb();
    if (attached.some((device) => device.id === id)) {
      throw new ProxmoxError("config", `USB device ${id} already present`);
    }

    const candidates = await this.infoUsbhost(filter);
    const added: string[] = [];
    // One at a time: the monitor is a single channel into a running guest.
    for (const [index, device] of candidates.entries()) {
      const deviceId = index ? `${id}-${index}` : id;
      await this.deviceAddByPort(deviceId, device);
      added.push(deviceId);
    }
    return added;
  }
}
