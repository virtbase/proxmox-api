/**
 * How many slots each indexed property actually has.
 *
 * PVE spells these `net[n]`, `scsi[n]`, `mp[n]` and so on. The published
 * schema does not carry the bound as data: seven prefixes state it in prose
 * ("n is 0 to 30"), the rest say nothing, and the prose is not reliable -
 * `usb[n]` reads "n is 0 to 4 ... n can be up to 14", which is two different
 * answers in one sentence.
 *
 * So the numbers come from the constants that generate these keys, and each
 * entry cites the one it came from. Values are the **last valid index**, which
 * is `MAX - 1` for the usual `for ($i = 0; $i < $MAX; $i++)` and `MAX` for the
 * inclusive `for (0 .. $MAX)` loops - a distinction worth keeping explicit,
 * since both spellings appear.
 *
 * Verified against the PVE 9 sources listed below. Where the schema also
 * states a range in prose, the two agree (except `usb`, see above).
 */
export const INDEX_BOUNDS: Readonly<Record<string, number>> = {
  // qemu-server: src/PVE/QemuServer/Drive.pm
  ide: 3, //      $MAX_IDE_DISKS = 4
  scsi: 30, //    $MAX_SCSI_DISKS = 31
  virtio: 15, //  $MAX_VIRTIO_DISKS = 16
  sata: 5, //     $MAX_SATA_DISKS = 6
  unused: 255, // $MAX_UNUSED_DISKS = 256

  // qemu-server: src/PVE/QemuServer.pm
  net: 31, //      $MAX_NETS = 32
  ipconfig: 31, // registered in the $MAX_NETS loop
  serial: 3, //    $MAX_SERIAL_PORTS = 4
  parallel: 2, //  $MAX_PARALLEL_PORTS = 3

  // qemu-server: src/PVE/QemuServer/{PCI,USB,Memory,Virtiofs}.pm
  hostpci: 15, //  $MAX_HOSTPCI_DEVICES = 16
  usb: 13, //      $MAX_USB_DEVICES = 14 (0..4 only on machine < 7.1)
  numa: 7, //      $MAX_NUMA = 8
  virtiofs: 9, //  $MAX_VIRTIOFS = 10

  // pve-container: src/PVE/LXC/Config.pm
  mp: 255, //  $MAX_MOUNT_POINTS = 256
  dev: 255, // $MAX_DEVICES = 256

  // pve-cluster: src/PVE/Corosync.pm - inclusive `for (0 .. MAX_LINK_INDEX)`
  link: 7, // MAX_LINK_INDEX => 7

  // pve-manager: PVE/NodeConfig.pm - inclusive `for my $i (0 .. $MAXDOMAINS)`
  acmedomain: 5, // $MAXDOMAINS = 5
};

/** `net[n]` -> `net`, or undefined when the name is not indexed. */
export function indexedPrefix(name: string): string | undefined {
  return name.endsWith("[n]") ? name.slice(0, -3) : undefined;
}

/**
 * The last index a prefix accepts, or undefined when we have no bound for it.
 *
 * An unknown prefix is not an error - it means Proxmox added an indexed
 * property we have not catalogued. The caller falls back to an unbounded key
 * pattern, which stays usable, and reports it so the table can be updated.
 */
export function lastIndex(prefix: string): number | undefined {
  return INDEX_BOUNDS[prefix];
}
