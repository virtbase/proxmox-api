// Proxmox-API Interactive proxmox API for developpers how do not like reading docs
// Copyright (C) 2020-2022  Chemouni Uriel <uchemouni@gmail.com>
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import type { Proxmox } from "./model.js";

// 'mem', // ERROR: VM XXX qmp command 'human-monitor-command' failed - got timeout
// 'tlb', // ERROR: VM XXX qmp command 'human-monitor-command' failed - got timeout

export const VALID_QEMU_INFO_SIMPLE = [
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

export const VALID_QEMU_INFO_OPTION = [
  "block",
  "lapic",
  "mtree",
  "qom-tree",
  "registers",
  "sync-profile",
  "trace-events",
] as const;

export const VALID_QEMU_INFO_PARAM = [
  "rocker-of-dpa-flows",
  "rocker-of-dpa-groups",
  "rocker-ports",
] as const;

export type QemuInfoSimple = (typeof VALID_QEMU_INFO_SIMPLE)[number];
export type QemuInfoOption = (typeof VALID_QEMU_INFO_OPTION)[number];
export type QemuInfoParam = (typeof VALID_QEMU_INFO_PARAM)[number];

/** One USB device attached to the guest, from `info usb`. */
export interface USBInfo {
  device: string;
  port: string;
  speed: string;
  /**
   * Absent for a device QEMU reports without a product string - the trailing
   * `, Product ..., ID: ...` is optional in the monitor's own output.
   */
  product?: string;
  /** Absent for the same reason as {@link USBInfo.product}. */
  id?: string;
}

/** One USB device present on the host, from `info usbhost`. */
export interface USBHostInfo {
  bus: number;
  addr: number;
  port: string;
  speed: string;
  class: string;
  vendorId: string;
  productId: string;
  name: string;
}

/** Narrows which host devices {@link QmMonitor.infoUsbhost} returns. */
export interface USBHostFilter {
  vendorId?: RegExp;
  productId?: RegExp;
  name?: RegExp;
}

// Device 1.1, Port 1, Speed 1.5 Mb/s, Product USB OPTICAL MOUSE , ID: mouse
// Device 1.0, Port 2, Speed 12 Mb/s, Product Gaming KB , ID: keyboard
const GUEST_USB =
  /Device ([\d.]+), Port ([\d.]+), Speed ([\d KMGTbfs/.]+)(?:, Product (.+), ID: (.+))?/g;

// Bus 1, Addr 4, Port 2, Speed 480 Mb/s
//   Class 00: USB device 1234:5678, Some Device
const HOST_USB =
  /Bus (\d+), Addr (\d+), Port ([\d.]+), Speed ([\d KMGTbfs/.]+)[\r\n]\s+Class (\d+): USB device ([0-9a-f]{4}):([0-9a-f]{4}), (.*)/gm;

/** Strip an optional `0x` prefix from a USB vendor or product id. */
function bareHexId(value: string): string {
  return value.replace(/^0x/i, "");
}

/**
 * QEMU monitor access for one guest, over
 * `POST /nodes/{node}/qemu/{vmid}/monitor`.
 *
 * The monitor is a debugging interface: commands are passed through
 * unvalidated and replies are unstructured text whose format is not stable
 * across QEMU versions. Prefer a real endpoint wherever one exists.
 */
export class QmMonitor {
  readonly node: string;
  readonly vmid: number;
  /** Send a raw monitor command and return its unparsed reply. */
  readonly monitor: (command: string) => Promise<string>;

  constructor(proxmox: Proxmox.Api, node: string, vmid: number) {
    this.node = node;
    this.vmid = vmid;
    const post = proxmox.nodes.$(node).qemu.$(vmid).monitor.$post;
    this.monitor = (command) => post({ command });
  }

  info(type: QemuInfoSimple): Promise<string>;
  info(type: QemuInfoOption, ...args: string[]): Promise<string>;
  info(type: QemuInfoParam, arg1: string, ...args: string[]): Promise<string>;
  /** Run `info <type>` and return the raw reply. */
  async info(
    type: QemuInfoSimple | QemuInfoOption | QemuInfoParam,
    ...args: string[]
  ): Promise<string> {
    const suffix = args.length > 0 ? ` ${args.join(" ")}` : "";
    return this.monitor(`info ${type}${suffix}`);
  }

  /**
   * USB devices currently attached to the guest.
   *
   * @throws if the reply has lines the device pattern did not match, which
   *   means QEMU changed the format and the result would be silently short.
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
      throw new Error(
        `Parsed ${devices.length} USB devices but the reply has ${expected} lines. ` +
          `The monitor output format may have changed:\n${text}`,
      );
    }
    return devices;
  }

  /**
   * USB devices present on the host, optionally narrowed by
   * vendor id, product id or name.
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
        // Each of these tested `usb.name` before, so filtering by vendor or
        // product id matched on the wrong field entirely.
        (!filter.vendorId || filter.vendorId.test(usb.vendorId)) &&
        (!filter.productId || filter.productId.test(usb.productId)),
    );
  }

  /**
   * Attach a host USB device by vendor and product id.
   *
   * @param id Identifier for the new device, used to detach it later.
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
   * Attach a host USB device by physical port, which survives swapping a
   * device for another of the same model.
   */
  async deviceAddByPort(
    id: string,
    params: { bus: number; port: string },
  ): Promise<string> {
    return this.monitor(
      `device_add usb-host,hostbus=${params.bus},hostport=${params.port},id=${id}`,
    );
  }

  /** Detach a device previously added under `id`. */
  async deviceDel(id: string): Promise<string> {
    return this.monitor(`device_del ${id}`);
  }

  /**
   * Attach every host device matching `filter` that is not already present.
   *
   * The first is added as `id`, subsequent ones as `id-1`, `id-2` and so on.
   *
   * @returns the ids that were attached.
   * @throws if `id` is already attached to the guest.
   */
  async deviceAddMissing(id: string, filter: USBHostFilter): Promise<string[]> {
    const attached = await this.infoUsb();
    if (attached.some((device) => device.id === id)) {
      throw new Error(`USB device ${id} already present`);
    }

    const candidates = await this.infoUsbhost(filter);
    const added: string[] = [];
    // Sequential, not concurrent: these were previously fired without being
    // awaited at all, so failures vanished and the guest saw an unbounded
    // burst of monitor commands.
    for (const [index, device] of candidates.entries()) {
      const deviceId = index ? `${id}-${index}` : id;
      await this.deviceAddByPort(deviceId, device);
      added.push(deviceId);
    }
    return added;
  }
}
