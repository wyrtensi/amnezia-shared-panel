import { HardDrive } from "lucide-react";
import type { DeviceType } from "@amnezia/contracts";
import { isDeviceType } from "@/lib/device-type";
import {
  AndroidMark,
  IosMark,
  LinuxMark,
  MacosMark,
  WindowsMark,
  type PlatformMark,
} from "@/components/icons/platform-marks";

/**
 * One glyph per device type, shared by the create-key wizard and the key card
 * so the two can never disagree — they used to keep separate maps, and one of
 * them grew an icon for a "phone2" that exists nowhere. `Record<DeviceType, …>`
 * is deliberate: adding a device type to the contract without an icon is a
 * compile error here.
 *
 * The five platforms use the vendored marks in components/icons/platform-marks
 * (operator decision D9). "other" and the stored-only "unspecified" have no
 * brand, so they keep the neutral lucide glyph.
 */
export const DEVICE_ICON = {
  android: AndroidMark,
  ios: IosMark,
  macos: MacosMark,
  windows: WindowsMark,
  linux: LinuxMark,
  other: HardDrive,
  unspecified: HardDrive,
} as const satisfies Record<DeviceType, PlatformMark>;

/**
 * Icon for a device type the API sent. Unknown values (an older key, a newer
 * API) get the neutral glyph rather than crashing an index lookup.
 */
export const deviceIconFor = (value: string): PlatformMark =>
  isDeviceType(value) ? DEVICE_ICON[value] : HardDrive;
