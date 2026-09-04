/*
 *   Copyright (c) 2026 Janic Bellmann
 *
 *   This program is free software: you can redistribute it and/or modify
 *   it under the terms of the GNU General Public License as published by
 *   the Free Software Foundation, either version 3 of the License, or
 *   (at your option) any later version.
 *
 *   This program is distributed in the hope that it will be useful,
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *   GNU General Public License for more details.
 *
 *   You should have received a copy of the GNU General Public License
 *   along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { describe, expect, test } from "bun:test";
import type { Proxmox } from "../model.js";
import { buildApiProxy } from "../proxy.js";
import { QmMonitor } from "../qm-monitor.js";
import { RecordingEngine } from "./helpers.js";

function monitor(...replies: string[]) {
  const engine = new RecordingEngine(...replies);
  const api = buildApiProxy<Proxmox.Api>(engine, "/api2/json");
  return { engine, qm: new QmMonitor(api, "pve1", 100) };
}

/** The command string sent by the nth monitor call. */
function commandAt(engine: RecordingEngine, index: number): string {
  const params = engine.calls[index]?.params;
  if (!params) throw new Error(`no monitor call recorded at index ${index}`);
  return (params as { command: string }).command;
}

describe("command construction", () => {
  test("targets the guest's monitor endpoint", async () => {
    const { engine, qm } = monitor("");
    await qm.monitor("info status");
    expect(engine.last.path).toBe("/api2/json/nodes/pve1/qemu/100/monitor");
    expect(engine.last.method).toBe("post");
  });

  test("exposes node and vmid", () => {
    const { qm } = monitor();
    expect(qm.node).toBe("pve1");
    expect(qm.vmid).toBe(100);
  });

  test("info builds `info <type>`", async () => {
    const { engine, qm } = monitor("");
    await qm.info("status");
    expect(commandAt(engine, 0)).toBe("info status");
  });

  test("info appends arguments with no trailing space when absent", async () => {
    const { engine, qm } = monitor("", "");
    await qm.info("block");
    await qm.info("mtree", "-f");
    expect(commandAt(engine, 0)).toBe("info block");
    expect(commandAt(engine, 1)).toBe("info mtree -f");
  });
});

describe("infoUsb", () => {
  const twoDevices =
    "Device 1.1, Port 1, Speed 1.5 Mb/s, Product USB OPTICAL MOUSE , ID: mouse\n" +
    "Device 1.0, Port 2, Speed 12 Mb/s, Product Gaming KB , ID: keyboard\n";

  test("parses attached devices", async () => {
    const { qm } = monitor(twoDevices);
    const devices = await qm.infoUsb();
    expect(devices).toHaveLength(2);
    expect(devices[0]).toEqual({
      device: "1.1",
      port: "1",
      speed: "1.5 Mb/s",
      product: "USB OPTICAL MOUSE ",
      id: "mouse",
    });
  });

  test("a device with no product string yields undefined, not a crash", async () => {
    const { qm } = monitor("Device 1.1, Port 1, Speed 1.5 Mb/s\n");
    const [device] = await qm.infoUsb();
    expect(device?.product).toBeUndefined();
    expect(device?.id).toBeUndefined();
    expect(device?.device).toBe("1.1");
  });

  test("throws when the reply has lines it could not parse", async () => {
    const { qm } = monitor(
      "Device 1.1, Port 1, Speed 1.5 Mb/s, Product M , ID: mouse\nsomething else\n",
    );
    expect(qm.infoUsb()).rejects.toThrow(/format may have changed/);
  });
});

describe("infoUsbhost", () => {
  const hostDevices =
    "Bus 1, Addr 4, Port 2, Speed 480 Mb/s\n  Class 00: USB device 046d:c52b, Logitech Receiver\n" +
    "Bus 2, Addr 5, Port 3, Speed 12 Mb/s\n  Class 03: USB device 1a2b:3c4d, Some Keyboard\n";

  test("parses host devices", async () => {
    const { qm } = monitor(hostDevices);
    const devices = await qm.infoUsbhost();
    expect(devices).toHaveLength(2);
    expect(devices[0]).toEqual({
      bus: 1,
      addr: 4,
      port: "2",
      speed: "480 Mb/s",
      class: "00",
      vendorId: "046d",
      productId: "c52b",
      name: "Logitech Receiver",
    });
  });

  test("filters by name", async () => {
    const { qm } = monitor(hostDevices);
    const devices = await qm.infoUsbhost({ name: /Logitech/ });
    expect(devices.map((d) => d.name)).toEqual(["Logitech Receiver"]);
  });

  test("filters by vendorId against the vendor id, not the name", async () => {
    const { qm } = monitor(hostDevices);
    const devices = await qm.infoUsbhost({ vendorId: /046d/ });
    expect(devices.map((d) => d.name)).toEqual(["Logitech Receiver"]);
  });

  test("filters by productId against the product id", async () => {
    const { qm } = monitor(hostDevices);
    const devices = await qm.infoUsbhost({ productId: /3c4d/ });
    expect(devices.map((d) => d.name)).toEqual(["Some Keyboard"]);
  });

  test("filters combine", async () => {
    const { qm } = monitor(hostDevices);
    expect(
      await qm.infoUsbhost({ vendorId: /046d/, productId: /3c4d/ }),
    ).toHaveLength(0);
  });
});

describe("device attachment", () => {
  test("deviceAddById strips a 0x prefix and does not mutate its argument", async () => {
    const { engine, qm } = monitor("");
    const params = { vendorId: "0x046d", productId: "0xc52b" };
    await qm.deviceAddById("usb0", params);
    expect(commandAt(engine, 0)).toBe(
      "device_add usb-host,vendorid=0x046d,productid=0xc52b,id=usb0",
    );
    expect(params).toEqual({ vendorId: "0x046d", productId: "0xc52b" });
  });

  test("deviceAddByPort addresses the physical port", async () => {
    const { engine, qm } = monitor("");
    await qm.deviceAddByPort("front2", { bus: 2, port: "4" });
    expect(commandAt(engine, 0)).toBe(
      "device_add usb-host,hostbus=2,hostport=4,id=front2",
    );
  });

  test("deviceDel detaches by id", async () => {
    const { engine, qm } = monitor("");
    await qm.deviceDel("usb0");
    expect(commandAt(engine, 0)).toBe("device_del usb0");
  });
});

describe("deviceAddMissing", () => {
  const hostDevices =
    "Bus 1, Addr 4, Port 2, Speed 480 Mb/s\n  Class 00: USB device 046d:c52b, Logitech Receiver\n" +
    "Bus 2, Addr 5, Port 3, Speed 12 Mb/s\n  Class 03: USB device 1a2b:3c4d, Some Keyboard\n";

  test("attaches each match, suffixing after the first", async () => {
    const { engine, qm } = monitor("", hostDevices, "", "");
    const added = await qm.deviceAddMissing("usb", {});

    expect(added).toEqual(["usb", "usb-1"]);
    expect(commandAt(engine, 2)).toBe(
      "device_add usb-host,hostbus=1,hostport=2,id=usb",
    );
    expect(commandAt(engine, 3)).toBe(
      "device_add usb-host,hostbus=2,hostport=3,id=usb-1",
    );
  });

  test("refuses when the id is already attached", async () => {
    const { qm } = monitor(
      "Device 1.1, Port 1, Speed 1.5 Mb/s, Product M , ID: usb\n",
    );
    expect(qm.deviceAddMissing("usb", {})).rejects.toThrow(/already present/);
  });

  test("awaits each attach, so a failure propagates", async () => {
    const engine = new RecordingEngine("", hostDevices);
    const original = engine.doRequest.bind(engine);
    engine.doRequest = (method, path, template, params) => {
      const command = (params as { command?: string })?.command ?? "";
      if (command.startsWith("device_add")) {
        return Promise.reject(new Error("monitor refused"));
      }
      return original(method, path, template, params);
    };
    const qm = new QmMonitor(
      buildApiProxy<Proxmox.Api>(engine, "/api2/json"),
      "pve1",
      100,
    );
    expect(qm.deviceAddMissing("usb", {})).rejects.toThrow("monitor refused");
  });
});
